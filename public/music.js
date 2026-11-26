/* ===== Tab Musik: cari lagu, putar (audio di-proxy server per potongan 1 MB), antrean, lirik =====
   Dimuat setelah shell.js, sebelum router.js (lihat index.html). Server: lib/music.js.
   Memakai global index.html: $, store, cid, app, devOn (let/const global, akses langsung).
   Kejadian: 'shell:tab' (dari Shell.setTab) menyegarkan layar saat tabnya tampil; 'devmode' (dari switch
   Mode dev di Pengaturan) hanya memasang/melepas konteks konsol dev (window.MU).

   STATUS: tab terbuka untuk SEMUA ORANG sekarang. Mode dev tetap dipakai untuk hal teknis:
   konteks konsol (window.MU) dan pesan error mentah dari server — user biasa melihat pesan ramah
   "Lagi error, tunggu nanti ya." (lihat tech() di bawah).

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
const dev = () => typeof devOn === 'function' && devOn(); /* Mode dev: pesan teknis & konteks konsol (lihat catatan status di atas) */
/* pesan teknis (kode error/status/detail server, hint debug & env) hanya untuk Mode dev; user biasa melihat pesan ramah */
const tech = m => { const s = String(m || '').trim(); return dev() || !s ? s : 'Lagi error, tunggu nanti ya.'; };
const active = () => app.dataset.tab === 'music';
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
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 20.5s-7.5-4.6-7.5-10A4.3 4.3 0 0112 7.9a4.3 4.3 0 017.5 2.6c0 5.4-7.5 10-7.5 10z" fill="currentColor" stroke="none"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M9 18V5l10-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm10-2a3 3 0 11-6 0 3 3 0 016 0z"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10.5 13.5a4.6 4.6 0 006.5 0l2.9-2.9a4.6 4.6 0 00-6.5-6.5l-1.5 1.4"/><path d="M13.5 10.5a4.6 4.6 0 00-6.5 0l-2.9 2.9a4.6 4.6 0 006.5 6.5l1.4-1.4"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5"/></svg>',
  shrink: '<svg viewBox="0 0 24 24"><path d="M20 10h-6V4M4 14h6v6M14 10l6.5-6.5M10 14l-6.5 6.5"/></svg>',
  sync: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.5"/><path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21"/></svg>',
  panel: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M14.5 4.5v15"/></svg>',
  vol2: '<svg class="sv" viewBox="0 0 24 24"><path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z"/><path d="M15.5 9a4 4 0 010 6M18 6.5a8 8 0 010 11"/></svg>',
  vol1: '<svg class="sv" viewBox="0 0 24 24"><path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z"/><path d="M15.5 9a4 4 0 010 6"/></svg>',
  vol0: '<svg class="sv" viewBox="0 0 24 24"><path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
  dots: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5.2" r="1.9" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.9" fill="currentColor" stroke="none"/><circle cx="12" cy="18.8" r="1.9" fill="currentColor" stroke="none"/></svg>',
  globe: '<svg class="sv" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.3 3.9 5.1 3.9 8.5s-1.3 6.2-3.9 8.5c-2.6-2.3-3.9-5.1-3.9-8.5s1.3-6.2 3.9-8.5z"/></svg>',
  lock: '<svg class="sv" viewBox="0 0 24 24"><rect x="5.5" y="10.5" width="13" height="9.5" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 018 0v3"/></svg>',
  /* ikon terjemahan (dari pemilik, SVG Repo ic_fluent_translate_24_filled): ikon ISI — fill currentColor, bukan garis */
  translate: '<svg viewBox="0 0 24 24"><path fill="currentColor" stroke="none" d="M15.3126,5.63994 C15.5095,5.12393 16.0874,4.86518 16.6034,5.06202 C17.1194,5.25885 17.3781,5.83674 17.1813,6.35275 L17.1231,6.5047 L20,6.5047 C20.5523,6.5047 21,6.95241 21,7.5047 C21,8.01753143 20.613973,8.44020653 20.1166239,8.4979722 L20,8.5047 L16.408,8.5047 C16.3727,8.61597 16.3415,8.72385 16.3095,8.85307 L16.2624044,9.05769402 C16.2224816,9.24420102 16.1803286,9.47537857 16.1319,9.7865 C16.7485,9.69083 17.3801,9.69058 17.9878,9.78147 C18.1704,9.58554 18.4307,9.463 18.7196,9.463 C19.2265,9.463 19.6453,9.84017 19.7107,10.3292 C20.8597,10.9243 21.7947,11.972 21.9755,13.4941 C22.2707552,15.9786655 20.5946372,17.395369 19.6742022,18.0480766 L19.3072,18.3102 C18.8588,18.6325 18.2339,18.5303 17.9115,18.0819 C17.6139923,17.6679923 17.6781888,17.1036941 18.0425043,16.7657518 L18.1398,16.6862 L18.4326,16.476 C19.2545,15.9068 20.1519,15.0967 19.9895,13.7301 C19.9282,13.2143 19.6897,12.7818 19.3086,12.4495 C19.1722,12.8174 19.0061,13.1851 18.8169,13.536 C18.2687,14.5532 17.426,15.6179 16.2993,16.1629 C15.699,16.4533 15.0149,16.5959 14.2802,16.4897 C12.8381,16.2813 11.9591,15.1465 11.9610932,13.8324 C11.9629,12.6195 12.691,11.4088 14.0044,10.5755 L14.0288,10.3678 L14.0288,10.3678 L14.1287918,9.65542111 C14.1918134,9.23346973 14.2487942,8.90963239 14.3071646,8.63697877 L14.3365,8.5047 L13,8.5047 C12.4477,8.5047 12,8.05698 12,7.5047 C12,6.99185929 12.386027,6.56919214 12.8833761,6.51142766 L13,6.5047 L14.9819,6.5047 L15.3126,5.63994 L15.3126,5.63994 Z M8.03218,6.28981 C8.67234,6.47762 9.18766,6.77412 9.58177,7.17134 C9.97581,7.56849 10.2055,8.02276 10.3366,8.46179 C10.4939444,8.98850889 10.5155407,9.55548642 10.5115347,9.97735674 L10.5006074,10.442137 L10.5006074,10.442137 L10.5,16.0027 C10.5,16.555 10.0523,17.0027 9.5,17.0027 C9.04562,17.0027 8.66202,16.6996 8.5403,16.2846 L8.46022,16.3236 C7.49628,16.786 6.06287,17.2446 4.58287,16.8305 C2.95032,16.3737 2.13002,15.021 2.01116,13.6946 C1.89649,12.415 2.42155,10.9593 3.69323,10.2474 C5.22152,9.39187 6.80844,9.40802 7.95475,9.60674 C8.15081,9.64072 8.3364,9.68042 8.50951,9.72294 C8.50661,9.48002 8.48727,9.2584 8.4203,9.03419 C8.36533,8.85015 8.28357,8.70251 8.162,8.57998 C8.04062,8.45764 7.83644,8.31683 7.47235,8.20986 C6.0832,7.80608 4.95416,8.18379 4.4236,8.43211 C3.92339,8.66622 3.3281,8.4505 3.09399,7.95029 C2.85988,7.45008 3.0756,6.85479 3.57581,6.62068 L3.80023213,6.52138857 C4.6519807,6.16546102 6.18766783,5.7531687 8.03218,6.28981 Z M4.67018,11.9926 C4.24564,12.2302 3.941,12.8223 4.00318,13.5161 C4.06116,14.1631 4.42427,14.7093 5.12175,14.9044 C5.91243,15.1257 6.80286,14.9005 7.59509,14.5204 C7.96191,14.3444 8.27459,14.1508 8.5,13.9972 L8.5,11.7992 C8.26004,11.7203 7.95707,11.637 7.61315,11.5773 C6.72905,11.4241 5.65682,11.4402 4.67018,11.9926 Z M14.1591,13.1697 C14.0146,13.4242 13.9614,13.6579 13.9611,13.8354 C13.9606,14.1765 14.13,14.4242 14.5055,14.4998 C14.4576,14.3507 14.4092,14.1903 14.3621,14.0205 C14.2903,13.7618 14.22,13.4758 14.1591,13.1697 Z M17.4425,11.7296 C16.9524,11.6868 16.4513,11.7311 15.9896,11.8598 C16.02736,12.32004 16.109408,12.770616 16.2104,13.1835728 L16.2893,13.4858 C16.3038,13.5379 16.3184,13.589 16.3331,13.639 C16.5958,13.343 16.8416,12.9856 17.0564,12.5871 C17.2137,12.2952 17.3421,12.0043 17.4425,11.7296 Z"/></svg>'
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
let lrcAway = false; // true = user menggulir lirik sendiri -> auto-scroll berhenti sampai tombol Sinkron ditekan
let lrcRaf = 0, lrcTick = 0; // id rAF animasi gulir lirik / loop sinkron per frame
let lrcIdx = -1, lrcHold = 0, lrcBuilt = ''; // baris aktif, jeda auto-scroll (user sedang menggulir), tanda isi yang sudah dirender
let trOn = false, trBusy = false; // terjemahan lirik: nyala? / sedang mengambil?
try { trOn = store.get('mlrctr') === '1' } catch {} // pilihan diingat seperti mode acak/ulang
const trCache = new Map(); // id lagu -> daftar terjemahan per baris (maks 30 lagu terakhir)
let sheet = false, sheetTab = 'lyrics';
const cur = () => (qi >= 0 && qi < queue.length ? queue[qi] : null);

/* muat/simpan antrean (pola store seperti pin/logs aplikasi); tab kini untuk semua orang, antrean juga dipulihkan untuk semua */
try { const o = JSON.parse(store.get('mqueue') || 'null'); if (o && Array.isArray(o.queue)) { queue = o.queue; qi = Math.min(o.qi ?? -1, o.queue.length - 1); repeat = ['off', 'all', 'one'].includes(o.repeat) ? o.repeat : 'off'; shuffle = !!o.shuffle; } } catch {}
let stT = 0, stBusy = null, stAt = 0; /* cadangan riwayat + antrean ke akun (lihat stCloud) */
const save = () => { store.set('mqueue', JSON.stringify({ queue: queue.slice(0, 100), qi, repeat, shuffle, u: Date.now() })); schedWarm(); stSched() };

/* riwayat putar ('mhist', terbaru di depan, maks 40) — jadi bahan rekomendasi di beranda.
   ch = channel YouTube Music artis utama (dari pencarian) — kunci baris "Lainnya dari X". */
const slim = s => ({ id: s.id, title: s.title, artist: s.artist, album: s.album || '', dur: s.dur || 0, thumb: s.thumb || '', ch: s.ch || '' });
const hget = () => { try { const a = JSON.parse(store.get('mhist') || '[]'); return Array.isArray(a) ? a : [] } catch { return [] } };
const hadd = s => { const a = hget().filter(x => x.id !== s.id); a.unshift(Object.assign(slim(s), { t: Date.now() })); store.set('mhist', JSON.stringify(a.slice(0, 40))); stSched() };

/* ---------- playlist ('mpl'): {pls:[{id,name,songs:[slim]}]}. id 'liked' = playlist bawaan "Lagu disukai" (selalu ada, urutan pertama).
   Dicadangkan ke akun di MongoDB (lihat plCloud); localStorage = cache perangkat. Kunci lama 'mlib' (daftar lagu tersimpan) dimigrasi ke 'liked'. ---------- */
const PL_KEY = 'mpl', LIKED = 'liked', PL_SONGS = 500, PL_MAX = 50;
let plc = null;
function plLoad() {
  let o = null; try { o = JSON.parse(store.get(PL_KEY) || 'null') } catch {}
  if (!o || !Array.isArray(o.pls)) {
    let old = []; try { const a = JSON.parse(store.get('mlib') || '[]'); if (Array.isArray(a)) old = a } catch {}
    o = { pls: [{ id: LIKED, name: 'Lagu disukai', songs: old }] };
  }
  o.pls = o.pls.filter(p => p && typeof p.id === 'string');
  if (!o.pls.some(p => p.id === LIKED)) o.pls.unshift({ id: LIKED, name: 'Lagu disukai', songs: [] });
  o.pls.forEach(p => { p.songs = (Array.isArray(p.songs) ? p.songs : []).filter(x => x && x.id).slice(0, PL_SONGS); p.name = p.id === LIKED ? 'Lagu disukai' : String(p.name || 'Playlist').slice(0, 60) });
  o.pls.sort((a, b) => (b.id === LIKED) - (a.id === LIKED)); /* sort stabil: bawaan di depan, sisanya urutan dibuat */
  return o;
}
/* tanda tangan per playlist (nama+publik+urutan lagu): plSave membandingkannya untuk tahu playlist mana yang berubah (-> cap waktu `u`)
   dan mana yang hilang (-> nisan hapus di plc.del). Dasar penggabungan cadangan akun (lihat plCloud di bawah). */
let plSigs = {};
const plSig = p => p.name + '|' + (p.pub || '') + '|' + p.songs.map(x => x.id).join(',');
const plStamp = () => { plSigs = {}; plc.pls.forEach(p => { plSigs[p.id] = plSig(p) }) };
const plAll = () => { if (!plc) { plc = plLoad(); plStamp() } return plc };
const plList = () => plAll().pls;
const plGet = id => plList().find(p => p.id === id) || null;
const plHas = (p, sid) => !!p && p.songs.some(x => x.id === sid);
function plSave() { /* false = gagal (penyimpanan penuh): muat ulang dari disk supaya memori tidak beda dengan yang tersimpan */
  try {
    const now = Date.now(), del = plc.del = (plc.del && typeof plc.del === 'object') ? plc.del : {}, have = new Set();
    for (const p of plc.pls) { have.add(p.id); const g = plSig(p); if (plSigs[p.id] !== g) { p.u = now; plSigs[p.id] = g; delete del[p.id] } }
    for (const id of Object.keys(plSigs)) if (!have.has(id)) { del[id] = now; delete plSigs[id] } /* playlist dihapus -> nisan, supaya tidak hidup lagi dari cadangan */
    for (const id of Object.keys(del)) if (now - del[id] > 90 * 864e5) delete del[id];
    localStorage.setItem(PL_KEY, JSON.stringify(plc)); store.set('mlib', null); plSync(); plCloudSched(); return true
  } catch { plc = null; return false }
}
const plNewId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
function plNextName(extra) {
  const used = new Set(plList().concat(extra || []).map(p => p.name));
  for (let n = 1; ; n++) { const t = 'Playlist #' + n; if (!used.has(t)) return t }
}
const plDur = p => p.songs.reduce((a, x) => a + (x.dur || 0), 0);
const plSub = p => p.songs.length + ' lagu';
/* isi sampul: bawaan = ikon hati; >=4 lagu = grid 2x2 dari 4 lagu pertama; 1-3 lagu = sampul lagu pertama; kosong = ikon not */
function covInner(p) {
  const l = p.songs;
  if (p.id === LIKED) return '<span class="mu-heart">' + SVG.heart + '</span>';
  if (l.length >= 4) return '<span class="mu-mos">' + l.slice(0, 4).map(x => '<img src="' + esc(x.thumb || '') + '" alt="" loading="lazy" draggable="false">').join('') + '</span>';
  if (l.length) return '<img src="' + esc(l[0].thumb || '') + '" alt="" loading="lazy" draggable="false">';
  return '<span class="mu-note">' + SVG.note + '</span>';
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
  '<div class="mnp-top"><button type="button" class="mnp-x" id="mnpx" aria-label="Tutup">' + SVG.close + '</button><span class="t">Sedang diputar</span><span class="mnp-sp" aria-hidden="true"></span></div>' +
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
  /* volume: di panel kanan (bar bawah yang punya volume disembunyikan saat panel terbuka) */
  '<div class="mnp-vol"><button type="button" class="mnp-vb" id="mnpvolb" aria-label="Bisukan / bunyikan">' + SVG.vol2 + '</button>' +
  '<input type="range" class="mupl-vol" id="mnpvol" min="0" max="100" value="100" aria-label="Volume"><span class="vp" id="mnpvolp">100</span></div>' +
  '<div class="mnp-tabs"><button type="button" class="mnp-tab on" id="mnptab-l" data-t="lyrics">Lirik</button><button type="button" class="mnp-tab" id="mnptab-q" data-t="queue">Antrean</button><button type="button" class="mnp-fb" id="mnpfull" aria-pressed="false" aria-label="Lirik layar penuh" title="Lirik layar penuh">' + SVG.expand + '</button></div>' +
  '<div class="mu-lrcw" id="mnplrcw" hidden><div id="mnplrc" class="mu-lrc" hidden></div>' +
  '<button type="button" class="mu-sync" id="mnpsync" hidden aria-label="Sinkronkan ke lirik yang sedang dinyanyikan">' + SVG.sync + '<span>Sinkron</span></button></div>' +
  '<div id="mnpq" hidden></div></div>' +
  /* terjemahan: bulat melayang di sudut kanan-bawah PANEL (di luar .mnp-in yang bisa digulir, jadi selalu terlihat) */
  '<button type="button" class="mnp-tr" id="mnptr" aria-pressed="false" aria-label="Terjemahan lirik" title="Terjemahkan lirik">' + SVG.translate + '</button>';
app.append(np);
const lrcBox = np.querySelector('#mnplrc'), qBox = np.querySelector('#mnpq'), lrcW = np.querySelector('#mnplrcw'), syncBtn = np.querySelector('#mnpsync');
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
/* lagu dari artis/channel yang SAMA: cocokkan ARTIS UTAMA lagu (nama pertama, bukan judul/kata pencarian).
   Kanal otomatis YouTube dianggap sama dengan artisnya ("Tulus - Topic" == "Tulus"); feat. tidak dihitung. */
const artNorm = n => String(n || '').trim().toLowerCase().replace(/\s*[-–]\s*(topic|official|vevo)\s*$/i, '').trim();
const sameArtist = (s, a) => { const t = artNorm(a); return !!t && artNorm(firstArtist(s.artist)) === t };
const CHEV = '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>';
function recPlan() {
  const h = hget(), cnt = {};
  /* artis dihitung per CHANNEL (ch) kalau ada — dua lagu dengan penulisan nama beda tapi artis sama
     tetap terhitung satu; lagu lama tanpa ch memakai nama (lalu digabung ke entri ber-ch yang sama). */
  h.forEach((s, i) => {
    const a = firstArtist(s.artist); if (!a || a === '—') return;
    const k = s.ch || artNorm(a), e = cnt[k] || (cnt[k] = { name: a, ch: s.ch || '', n: 0 });
    e.n += h.length - i; if (s.ch) e.ch = s.ch /* lagu yang lebih baru berbobot lebih besar */
  });
  for (const k of Object.keys(cnt)) { /* tanpa ch tapi ada entri ber-ch dengan nama sama -> gabungkan */
    if (cnt[k].ch) continue;
    const t = Object.values(cnt).find(x => x.ch && artNorm(x.name) === k);
    if (t) { t.n += cnt[k].n; delete cnt[k] }
  }
  const top = Object.values(cnt).sort((a, b) => b.n - a.n).slice(0, 3);
  const qs = [{ key: 'r0', q: 'lagu indonesia populer', rec: true }, { key: 'r1', q: 'top hits 2026', rec: true }]
    .concat(top.length ? top.map((t, i) => ({ key: 'a' + i, q: t.name, artist: t.name, ch: t.ch })) : [{ key: 'g0', q: 'lagu viral', title: 'Lagu viral' }]);
  return { hist: h, personal: !!top.length, qs };
}
async function loadRec() {
  if (recBusy) return;
  const plan = recPlan(), k = plan.qs.map(x => x.q + (x.ch ? '@' + x.ch : '')).join('|');
  if (rec && rec.k === k && !rec.err) return;
  try {
    const c = JSON.parse(store.get('mrec5') || 'null'); /* mrec5: baris artis dari halaman artis (channel), bukan cari nama (mrec4 lama) */
    if (c && c.k === k && Date.now() - c.t < REC_TTL && Array.isArray(c.secs) && c.secs.length) { rec = { k, secs: c.secs }; paintHome(); return }
  } catch {}
  recBusy = true; paintHome();
  const pick = j => Array.isArray(j && j.songs) ? j.songs.filter(s => s && s.id) : [];
  /* artis punya channel (ch)? ambil SEMUA lagunya dari halaman artis (semua lagu memang milik channel
     itu — artis lain yang kebetulan bernama sama tidak ikut, dan tidak lagi "sepi" karena cuma 20
     hasil cari nama). Gagal -> fallback cari nama + filter artis (jalur lama). */
  const one = async x => {
    if (x.ch) {
      const j = await jget('/api/music/artist-songs?id=' + encodeURIComponent(x.ch) + '&clientId=' + encodeURIComponent(cid));
      if (j && j.ok && j.songs && j.songs.length) return { x, all: pick(j), artist: j.artist || x.artist, byCh: true };
    }
    const j = await jget('/api/music/search?q=' + encodeURIComponent(x.q) + '&clientId=' + encodeURIComponent(cid));
    return { x, all: pick(j), artist: x.artist, byCh: false };
  };
  const got = await Promise.all(plan.qs.map(one));
  recBusy = false;
  const seen = new Set(plan.personal ? plan.hist.map(s => s.id) : []);
  const rows = [];
  /* baris artis/lainnya dulu (agar tidak habis dimakan Rekomendasi), tapi ditampilkan setelah Rekomendasi */
  got.filter(g => !g.x.rec).forEach(({ x, all, artist, byCh }) => {
    /* dari halaman artis: lagunya memang milik artis itu semua. Dari cari nama: saring yang artis utamanya cocok */
    const own = byCh ? all : (x.artist ? all.filter(s => sameArtist(s, x.artist)) : all);
    const songs = own.filter(s => !seen.has(s.id)).slice(0, 100).map(slim); /* maks 100 lagu per baris artis (server juga memotong 100) */
    songs.forEach(s => seen.add(s.id));
    if (songs.length) rows.push(x.artist ? { key: x.key, title: artist || x.artist, sub: 'Lainnya dari', avatar: (own[0] && own[0].thumb) || songs[0].thumb, songs } : { key: x.key, title: x.title, songs });
  });
  const lists = got.filter(g => g.x.rec).map(g => g.all), mix = [];
  for (let i = 0; mix.length < 30 && i < 20; i++) for (const l of lists) { const s = l[i]; if (s && !seen.has(s.id)) { seen.add(s.id); mix.push(slim(s)) } }
  const secs = (mix.length ? [{ key: 'rec', title: 'Rekomendasi', songs: mix }] : []).concat(rows);
  rec = { k, secs, err: !secs.length };
  if (secs.length) store.set('mrec5', JSON.stringify({ k, t: Date.now(), secs }));
  paintHome();
}
function cardHtml(s, key, i) {
  const c = cur(), now = c && c.id === s.id;
  return '<button type="button" class="mu-card' + (now ? ' now' : '') + '" data-k="' + key + '" data-i="' + i + '">' +
    '<span class="cv"><img src="' + esc(s.thumb || '') + '" alt="" loading="lazy" draggable="false">' +
    (key === 'srv' ? '<span class="pin">PERMANEN</span>' : '') +
    (now ? '<span class="mu-eq" aria-label="Sedang diputar"><i></i><i></i><i></i></span>' : '') +
    '<span class="pp" aria-hidden="true">' + SVG.play + '</span>' +
    '<span class="mu-cadd" role="button" tabindex="0" data-add title="Tambah ke antrean" aria-label="Tambah ' + esc(s.title) + ' ke antrean">' + SVG.plus + '</span></span>' +
    '<b class="t">' + esc(s.title || s.id) + '</b><span class="a">' + esc(s.artist || '—') + '</span></button>';
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
  const hist = hget().slice(0, 40);
  let h = plSecHtml();
  h += srvSecHtml();
  h += oplSecHtml();
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
  const dt = e.target.closest('[data-dots]'); /* titik-tiga: menu publik/private (jangan buka playlist) */
  if (dt) { e.stopPropagation(); const p = plGet(dt.dataset.dots); if (p) pmOpen(p, dt); return }
  if (card.dataset.pl) { const p = plGet(card.dataset.pl); if (!p) return; if (e.target.closest('.pp')) { if (p.songs.length) playSong(0, p.songs.slice()) } else openPl(p.id); return }
  if (card.dataset.opl) { /* playlist publik: putar langsung dari tombol putar, selain itu buka halamannya (milik sendiri -> halaman diberi tanda "kamu") */
    const od = opl && opl.pls.find(x => x.code === card.dataset.opl);
    openShared(card.dataset.opl, e.target.closest('.pp') ? true : false, !!(od && od.mine), od && od.pid); return }
  const list = recLists[card.dataset.k], i = +card.dataset.i;
  if (!list || !list[i]) return;
  if (e.target.closest('[data-add]')) { e.stopPropagation(); queue.push(list[i]); save(); say('Ditambahkan ke antrean: ' + list[i].title); if (sheet) renderSheet(); return }
  playSong(0, list.slice(i).concat(list.slice(0, i))); /* klik = putar; sisanya mengikuti sebagai antrean */
}

/* ---------- halaman "Lihat semua": seluruh isi satu kategori sebagai halaman sendiri (tombol kembali) ---------- */
function pageSongs() {
  if (!page) return [];
  const l = page.key === 'hist' ? hget().slice(0, 40) : page.key === 'srv' ? (srv ? srv.songs : []) : (recLists[page.key] || []);
  recLists[page.key] = l;
  return l;
}
function openPage(key) {
  const meta = key === 'hist' ? { key, title: 'Jump back in' } : key === 'srv' ? { key, title: 'Lagu tersimpan di server', sub: 'Permanen di data server' } : (rec && rec.secs || []).find(x => x.key === key);
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
  if (page.key.startsWith('pl:')) { renderPlPage(); return }
  if (page.key === 'srv') { renderSrvPage(); return }
  if (page.key === 'share') { renderSharePage(); return }
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
  if (page && page.key.startsWith('pl:')) { if (active()) renderPlPage(true); return }
  if (page && page.key === 'srv') { if (active()) renderSrvPage(true); return }
  if (page && page.key === 'share') { if (active()) renderSharePage(true); return }
  const g = $('mupage');
  if (!g || !active() || !page) return;
  const l = pageSongs();
  g.innerHTML = l.map((x, i) => cardHtml(x, page.key, i)).join('');
  const n = $('mupgn'); if (n) n.textContent = l.length + ' lagu';
}

/* ---------- playlist: baris di beranda + halaman playlist (ala halaman album) ---------- */
function plSecHtml() {
  const l = plList();
  if (l.length < 2 && !l[0].songs.length) return ''; /* belum ada apa pun: jangan tampilkan baris kosong */
  return '<section class="mu-sec" data-sec="pls"><div class="mu-shr"><div class="mu-sht"><div><h2>Playlist kamu</h2></div></div></div><div class="mu-rw"><div class="mu-grid">' +
    l.map(p => '<button type="button" class="mu-card" data-pl="' + esc(p.id) + '"><span class="cv">' + covInner(p) +
      (p.pub ? '<span class="mu-pubtag">Publik</span>' : '') +
      (p.songs.length ? '<span class="pp" role="button" aria-label="Putar ' + esc(p.name) + '">' + SVG.play + '</span>' : '') +
      '<span class="mu-dots" role="button" tabindex="0" data-dots="' + esc(p.id) + '" aria-label="Opsi playlist: publik atau private" title="Publik / private">' + SVG.dots + '</span></span>' +
      '<b class="t">' + esc(p.name) + '</b><span class="a">Playlist · ' + plSub(p) + '</span></button>').join('') + '</div>' +
    '<button type="button" class="mu-arr l" data-arr="-1" aria-label="Geser ke kiri" hidden>' + CHEV + '</button>' +
    '<button type="button" class="mu-arr r" data-arr="1" aria-label="Geser ke kanan" hidden>' + CHEV + '</button></div></section>';
}
function openPl(id) {
  const p = plGet(id); if (!p) return;
  pageY = $('music') ? $('music').scrollTop : 0;
  page = { key: 'pl:' + id, title: p.name };
  render();
  if ($('music')) $('music').scrollTop = 0;
}
const fmtLong = s => { const m = Math.round(s / 60); return m >= 60 ? Math.floor(m / 60) + ' j ' + (m % 60) + ' mnt' : Math.max(1, m) + ' mnt' };
let plArm = 0;
function renderPlPage(keepY) {
  const p = plGet(page.key.slice(3));
  if (!p) { page = null; render(); return }
  const y = keepY && $('music') ? $('music').scrollTop : 0, c = cur(), own = p.id !== LIKED;
  body.innerHTML =
    '<div class="mu-ptw"><button type="button" class="mu-ptog" id="muptog" aria-label="Tampilkan pemutar" title="Tampilkan pemutar">' + SVG.panel + '</button></div>' +
    '<div class="mu-pgh"><button type="button" class="mu-back" id="muback" aria-label="Kembali">' + CHEV + '</button></div>' +
    '<div class="mu-plh"><div class="mu-plc">' + covInner(p) + '</div><div class="mu-plm"><small>Playlist</small><h1 id="mupln">' + esc(p.name) + '</h1>' +
    '<p>' + plSub(p) + (p.songs.length ? ' · ' + fmtLong(plDur(p)) : '') + '</p>' +
    (p.pub ? '<p class="mu-publine">' + SVG.globe + 'Publik — dibagikan lewat /music?pl=' + esc(p.pub) + '</p>' : '') + '</div></div>' +
    '<div class="mu-pla"><button type="button" class="mupl-play big" id="muplplay" aria-label="Putar playlist"' + (p.songs.length ? '' : ' disabled') + '>' + SVG.play + '</button>' +
    '<button type="button" class="mu-plb" id="muplsh" aria-label="Putar acak" title="Putar acak"' + (p.songs.length ? '' : ' disabled') + '>' + SVG.shuffle + '</button>' +
    '<button type="button" class="mu-plb" id="mupladd" aria-label="Tambah lagu lewat link" title="Tambah lagu lewat link">' + SVG.plus + '</button>' +
    (own ? '<button type="button" class="mu-plb" id="muplren" aria-label="Ubah nama" title="Ubah nama">' + SVG.edit + '</button>' +
      '<button type="button" class="mu-plb" id="mupldel" aria-label="Hapus playlist" title="Hapus playlist">' + SVG.trash + '</button>' : '') +
    '<button type="button" class="mu-plb" id="mupldots" aria-label="Publik / private" title="Publik / private">' + SVG.dots + '</button></div>' +
    (p.songs.length ? '<div class="mu-trs" id="mutrs">' + p.songs.map((x, i) =>
      '<div class="mu-tr' + (c && c.id === x.id ? ' now' : '') + '" data-i="' + i + '" role="button" tabindex="0">' +
      '<span class="n">' + (c && c.id === x.id ? '<span class="mu-eq" aria-label="Sedang diputar"><i></i><i></i><i></i></span>' : i + 1) + '</span>' +
      '<img src="' + esc(x.thumb || '') + '" alt="" loading="lazy">' +
      '<span class="si"><b>' + esc(x.title) + '</b><span>' + esc(x.artist) + '</span></span>' +
      '<span class="al">' + esc(x.album || '') + '</span><span class="dur">' + fmt(x.dur) + '</span>' +
      '<span class="rm" role="button" tabindex="0" data-rm="' + i + '" title="Hapus dari playlist" aria-label="Hapus ' + esc(x.title) + ' dari playlist">' + SVG.close + '</span></div>').join('') + '</div>'
      : '<div class="mu-msg">Playlist ini masih kosong. Putar lagu, klik tombol <b>+</b> di bar bawah sampai jadi centang, lalu klik lagi untuk memilih playlist ini.</div>');
  if ($('music')) $('music').scrollTop = y;
  $('muback').addEventListener('click', closePage);
  $('muptog').addEventListener('click', () => setPanel(true));
  $('muplplay').addEventListener('click', () => { if (p.songs.length) playSong(0, p.songs.slice()) });
  $('muplsh').addEventListener('click', () => { if (!p.songs.length) return; shuffle = true; save(); playSong(Math.floor(Math.random() * p.songs.length), p.songs.slice()) });
  $('mupladd').addEventListener('click', () => piOpen(p));
  if (own) {
    $('muplren').addEventListener('click', () => {
      const h = $('mupln'); if (h.querySelector('input')) return;
      h.innerHTML = '<input class="mu-rn" maxlength="60" aria-label="Nama playlist">';
      const inp = h.firstChild; inp.value = p.name; inp.focus(); inp.select();
      let done = false;
      const fin = ok => { if (done) return; done = true; const v = inp.value.trim(); if (ok && v && v !== p.name) { p.name = v.slice(0, 60); plSave() } renderPlPage(true); paintHome() };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') fin(true); else if (e.key === 'Escape') { e.stopPropagation(); fin(false) } });
      inp.addEventListener('blur', () => fin(true));
    });
    $('mupldel').addEventListener('click', async () => {
      const b = $('mupldel');
      if (!plArm) { plArm = setTimeout(() => { plArm = 0; if ($('mupldel')) { $('mupldel').classList.remove('arm'); $('mupldel').title = 'Hapus playlist' } }, 3000); b.classList.add('arm'); b.title = 'Tap lagi untuk menghapus'; say('Tap sekali lagi untuk menghapus playlist ini'); return }
      clearTimeout(plArm); plArm = 0;
      if (p.pub) { /* playlist publik: matikan dulu linknya di server, baru hapus lokal. Dulu unshare
         dikirim tanpa menunggu hasil — kalau gagal (offline/token mati/429) salinan server tetap
         hidup: playlist "hilang" di sini tapi masih muncul di akun lain dan tak bisa diurus lagi */
        say('Mematikan link publik…');
        const j = await jpost('/api/auth/pl/unshare', { pid: p.id });
        if (!(j && j.ok)) { say((j && j.error) || 'Gagal mematikan link publik — playlist tidak dihapus. Coba lagi.'); return }
        p.pub = '';
      }
      const l = plList(), i = l.findIndex(x => x.id === p.id); if (i > 0) l.splice(i, 1);
      plSave(); say('Playlist dihapus: ' + p.name); paintAdd(); closePage();
    });
  }
  const dotsBtn = $('mupldots');
  if (dotsBtn) dotsBtn.addEventListener('click', () => pmOpen(p, dotsBtn));
  const t = $('mutrs');
  if (t) t.addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { e.stopPropagation(); const i = +rm.dataset.rm; p.songs.splice(i, 1); plSave(); paintAdd(); renderPlPage(true); return }
    const row = e.target.closest('.mu-tr');
    if (row) { const i = +row.dataset.i; playSong(0, p.songs.slice(i).concat(p.songs.slice(0, i))) }
  });
}

/* ---------- playlist publik/private: menu titik-tiga (⋮) di playlist ----------
   Private (bawaan): playlist cuma ada di perangkat ini. "Jadikan Publik": isi playlist diunggah
   ke server (koleksi music_pl lewat /api/auth/pl/* — butuh masuk akun) dan dapat KODE tetap;
   siapa pun yang membuka /music?pl=KODE bisa memutar & menyimpannya (tamu juga bisa).
   "Jadikan Private": kode dihapus dari server, link lama mati. Playlist diubah saat publik ->
   salinan di server diperbarui otomatis (kode tidak berubah). */
const jpost = async (url, body) => {
  try {
    const hd = { 'Content-Type': 'application/json' };
    if (typeof atok === 'string' && atok) hd.Authorization = 'Bearer ' + atok;
    const r = await fetch(url, { method: 'POST', headers: hd, body: JSON.stringify(body || {}) });
    return await r.json().catch(() => ({}))
  } catch { return { error: 'Gagal menghubungi server' } }
};
const pm = document.createElement('div'); pm.id = 'mupm'; pm.hidden = true; pm.setAttribute('role', 'menu'); pm.setAttribute('aria-label', 'Opsi playlist');
app.append(pm);
let pmPl = null, pmBusy = false;
function pmPaint() {
  const p = pmPl;
  if (!p) { pm.hidden = true; return }
  const pub = !!p.pub;
  pm.innerHTML = '<div class="pm-h">' + esc(p.name) + '</div>' +
    '<button type="button" class="pm-i" data-pm="pub"' + (pmBusy ? ' disabled' : '') + '>' + (pub ? SVG.globe : SVG.lock) +
    '<span><b>' + (pub ? 'Publik' : 'Private') + '</b><small>' + (pub ? 'Dibagikan lewat link — siapa pun bisa memutar' : 'Hanya ada di perangkat ini') + '</small></span>' +
    '<span class="pm-sw' + (pub ? ' on' : '') + '" aria-hidden="true"></span></button>' +
    (pub ? '<button type="button" class="pm-i" data-pm="copy">' + SVG.link + '<span><b>Salin Link</b><small>/music?pl=' + esc(p.pub) + '</small></span></button>' : '');
}
function pmOpen(p, anchor) {
  pmPl = p; pmBusy = false; pmPaint(); pm.hidden = false;
  const r = anchor.getBoundingClientRect(), w = Math.min(300, innerWidth - 16);
  pm.style.width = w + 'px';
  pm.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
  let top = r.bottom + 6;
  if (top + pm.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - pm.offsetHeight - 6); /* mepet bawah: balik ke atas */
  pm.style.top = top + 'px';
}
function pmClose() { pm.hidden = true; pmPl = null; pmBusy = false }
const pmLink = p => location.origin + '/music?pl=' + p.pub;
function pmCopy(p) {
  const url = pmLink(p);
  try { navigator.clipboard.writeText(url).then(() => say('Link tersalin: ' + url), () => say(url)) } catch { say(url) }
}
/* perbarui salinan publik di server setelah playlist berubah (kode tetap) — sekali, tunda 1.5 dtk */
let pmSyncT = 0;
function plSync() {
  if (typeof atok !== 'string' || !atok) return;
  clearTimeout(pmSyncT);
  pmSyncT = setTimeout(async () => {
    for (const p of plList()) if (p.pub && p.songs.length) await jpost('/api/auth/pl/share', { pid: p.id, name: p.name, songs: p.songs });
  }, 1500);
}
/* ---------- cadangan playlist per akun ----------
   Dulu 'mpl' cuma di localStorage, padahal Keluar menjalankan wipeLocal() = localStorage.clear(): setiap logout->login
   semua playlist lenyap, dan yang tersisa hanya salinan publik di server yang tampil sebagai playlist \"orang lain\"
   (read-only, tidak bisa diedit). Sekarang seluruh daftar playlist (privat + publik) dicadangkan ke akun
   (/api/auth/pl/mine/*) tiap berubah dan ditarik lagi saat masuk / buka aplikasi.
   Gabung: id sama -> `u` (cap waktu ubah) terbaru menang (seri: yang lagunya lebih banyak); id yang punya nisan hapus
   (plc.del) tidak ikut kembali. Data perangkat yang ber-cap akun LAIN (plc.own) tidak pernah digabung/dikirim ke akun ini. */
let plCT = 0, plCBusy = null, plCAt = 0;
const plLogged = () => typeof atok === 'string' && !!atok;
/* sidik ringkas satu daftar playlist: id, nama, status publik, cap waktu `u` dan urutan id lagu (isi lagu sendiri tidak dibandingkan: `u` berubah kalau isinya berubah) */
const plDigest = (pls, del) => (pls || []).map(p => [p.id, p.name, p.pub || '', p.u || 0, (p.songs || []).map(x => x.id).join(',')].join('|')).join('\n') + '\n#' + JSON.stringify(del || {});
function plMergeCloud(loc, rem) {
  const del = Object.assign({}, rem.del || {});
  for (const [k, v] of Object.entries(loc.del || {})) del[k] = Math.max(del[k] || 0, v);
  const by = new Map();
  for (const p of (rem.pls || [])) if (p && p.id) by.set(p.id, p);
  for (const p of loc.pls) {
    const r = by.get(p.id);
    if (!r || (p.u || 0) > (r.u || 0) || ((p.u || 0) === (r.u || 0) && p.songs.length >= (r.songs || []).length)) by.set(p.id, p);
  }
  const pls = [...by.values()].filter(p => p.id === LIKED || !(del[p.id] && del[p.id] >= (p.u || 0)));
  pls.forEach(p => { if (p.id !== LIKED && del[p.id] && del[p.id] < (p.u || 0)) delete del[p.id] }); /* diubah setelah dihapus di perangkat lain: batalkan nisan */
  return { pls, del };
}
/* tarik -> gabung -> (kalau beda) simpan lokal + dorong ke akun. Promise<boolean>: true = akun & perangkat sinkron */
function plCloud(force) {
  if (!plLogged()) return Promise.resolve(true);
  if (plCBusy) return plCBusy;
  if (!force && Date.now() - plCAt < 30e3) return Promise.resolve(true);
  return plCBusy = (async () => {
    try {
      const j = await jpost('/api/auth/pl/mine/pull', {});
      if (!(j && j.ok && j.uid)) return false;
      const remPls = Array.isArray(j.pls) ? j.pls : null, remDel = j.del || {};
      const loc = plAll();
      const fresh = !store.get(PL_KEY) && !store.get('mlib'); /* perangkat kosong (baru / habis Keluar): ambil punya akun apa adanya */
      const foreign = !!(loc.own && loc.own !== j.uid);       /* sisa data akun lain: jangan digabung, apalagi dikirim ke akun ini */
      let next;
      if (foreign || fresh) next = (remPls && remPls.length) || foreign ? { pls: remPls || [], del: remDel } : { pls: loc.pls, del: loc.del || {} }; /* akun belum punya cadangan & perangkat kosong: pertahankan lokal */
      else next = plMergeCloud(loc, { pls: remPls || [], del: remDel });
      /* bentuk akhir seperti plLoad: Lagu disukai selalu ada & di depan, batas jumlah lagu */
      const pls = next.pls.filter(p => p && typeof p.id === 'string').map(p => ({ id: p.id, name: p.id === LIKED ? 'Lagu disukai' : String(p.name || 'Playlist').slice(0, 60), pub: p.pub || '', u: p.u || 0, songs: (Array.isArray(p.songs) ? p.songs : []).filter(x => x && x.id).slice(0, PL_SONGS) }));
      if (!pls.some(p => p.id === LIKED)) pls.unshift({ id: LIKED, name: 'Lagu disukai', pub: '', u: 0, songs: [] });
      pls.sort((a, b) => (b.id === LIKED) - (a.id === LIKED));
      const merged = { pls, del: next.del || {}, own: j.uid };
      const dLoc = plDigest(loc.pls, loc.del), dNew = plDigest(merged.pls, merged.del);
      if (dNew !== dLoc || loc.own !== j.uid) {
        try { localStorage.setItem(PL_KEY, JSON.stringify(merged)) } catch { return false }
        plc = merged; plStamp(); paintAdd(); paintHome(); paintPage();
      }
      if (!remPls || dNew !== plDigest(remPls, remDel)) { /* isi akun beda dengan hasil gabungan -> dorong */
        const r = await jpost('/api/auth/pl/mine/push', { pls: merged.pls, del: merged.del });
        if (!(r && r.ok)) return false;
      }
      plCAt = Date.now();
      return true;
    } catch { return false } finally { plCBusy = null }
  })();
}
function plCloudSched() { /* tiap playlist berubah: dorong ke akun setelah jeda 1.5 dtk */
  if (!plLogged()) return;
  clearTimeout(plCT); plCT = setTimeout(() => { plCT = 0; plCloud(true) }, 1500);
}
/* ---------- cadangan riwayat putar + antrean per akun ----------
   Sama seperti playlist: 'mhist' & 'mqueue' hilang saat Keluar (wipeLocal). Sekarang disimpan di MongoDB per akun
   (/api/auth/pl/state/*) dan ditarik lagi saat masuk. Riwayat digabung per lagu (cap waktu `t` terbaru, maks 40).
   Antrean: yang `u` terbaru menang, tapi antrean dari akun HANYA dipasang kalau perangkat ini belum punya antrean dan
   tidak sedang memutar (tidak pernah menggeser lagu yang sedang didengar). Data ber-cap akun lain ('mhown') dibuang. */
const stDigest = h => (h || []).map(x => x.id + ':' + (x.t || 0)).join(',');
const stMergeHist = (a, b) => { const m = new Map(); for (const x of (a || []).concat(b || [])) { if (!x || !x.id) continue; const o = m.get(x.id); if (!o || (x.t || 0) > (o.t || 0)) m.set(x.id, x) } return [...m.values()].sort((p, q) => (q.t || 0) - (p.t || 0)).slice(0, 40) };
const stPlaying = () => { try { return !!(audio.src && !audio.paused) } catch { return false } };
function stCloud(force) {
  if (!plLogged()) return Promise.resolve(true);
  if (stBusy) return stBusy;
  if (!force && Date.now() - stAt < 30e3) return Promise.resolve(true);
  return stBusy = (async () => {
    try {
      const j = await jpost('/api/auth/pl/state/pull', {});
      if (!(j && j.ok && j.uid)) return false;
      const alien = !!(store.get('mhown') && store.get('mhown') !== j.uid); /* sisa data akun lain: jangan digabung / dikirim */
      const remH = Array.isArray(j.hist) ? j.hist : [], remQ = j.q && Array.isArray(j.q.queue) ? j.q : null;
      /* riwayat */
      const curH = hget(), hist = stMergeHist(alien ? [] : curH, remH), hChanged = alien || stDigest(hist) !== stDigest(curH);
      if (hChanged) store.set('mhist', JSON.stringify(hist));
      /* antrean */
      let locQ = null; try { locQ = JSON.parse(store.get('mqueue') || 'null') } catch {}
      if (alien) { locQ = null; store.set('mqueue', null) }
      const locHas = !!(locQ && Array.isArray(locQ.queue) && locQ.queue.length);
      let applied = alien, pushQ = null;
      if (alien && !stPlaying()) { queue = []; qi = -1 }
      if (remQ && remQ.queue.length && !locHas && !stPlaying() && !queue.length) {
        queue = remQ.queue.slice(0, 100); qi = Math.min(Number.isInteger(remQ.qi) ? remQ.qi : -1, queue.length - 1);
        repeat = ['off', 'all', 'one'].includes(remQ.repeat) ? remQ.repeat : 'off'; shuffle = !!remQ.shuffle;
        store.set('mqueue', JSON.stringify({ queue, qi, repeat, shuffle, u: remQ.u || 0 })); applied = true;
      } else if (locHas && (!remQ || (locQ.u || 0) > (remQ.u || 0))) {
        pushQ = { queue: locQ.queue.slice(0, 100).map(slim), qi: locQ.qi, repeat: locQ.repeat, shuffle: locQ.shuffle, u: locQ.u || Date.now() };
      }
      if (stDigest(hist) !== stDigest(remH) || pushQ) { /* isi akun beda -> dorong (q lama akun dipertahankan kalau antrean lokal tidak menggantinya) */
        const r = await jpost('/api/auth/pl/state/push', { hist, q: pushQ || remQ });
        if (!(r && r.ok)) return false;
      }
      store.set('mhown', j.uid);
      if (hChanged) { paintHome(); paintPage() }
      if (applied) { renderPl(); renderSheet() }
      stAt = Date.now();
      return true;
    } catch { return false } finally { stBusy = null }
  })();
}
function stSched() { /* riwayat/antrean berubah: cadangkan setelah jeda 5 dtk (antrean berubah tiap ganti lagu) */
  if (!plLogged()) return;
  clearTimeout(stT); stT = setTimeout(() => { stT = 0; stCloud(true) }, 5000);
}
const mCloud = force => Promise.all([plCloud(force), stCloud(force)]).then(r => r.every(Boolean)); /* playlist + riwayat + antrean */
/* dipanggil index.html: sebelum Keluar (wipeLocal) & sesudah masuk. true = aman */
window.mplFlush = async () => { clearTimeout(plCT); plCT = 0; clearTimeout(stT); stT = 0; if (!plLogged()) return true; if (plCBusy) await plCBusy; if (stBusy) await stBusy; return await mCloud(true) };
window.mplSync = () => mCloud(true);
pm.addEventListener('click', async e => {
  const b = e.target.closest('[data-pm]'); if (!b || !pmPl || pmBusy) return;
  const p = pmPl;
  if (b.dataset.pm === 'copy') { pmCopy(p); return }
  if (b.dataset.pm !== 'pub') return;
  if (p.pub) { /* publik -> private: hapus kode dari server */
    pmBusy = true; pmPaint();
    const j = await jpost('/api/auth/pl/unshare', { pid: p.id });
    pmBusy = false;
    if (j && j.ok) { p.pub = ''; plSave(); say('Playlist sekarang private: ' + p.name); pmPaint(); paintHome(); if (page && page.key === 'pl:' + p.id) renderPlPage(true) }
    else say((j && j.error) || 'Gagal mengubah ke private');
    return;
  }
  if (!(typeof atok === 'string' && atok)) { say('Masuk dulu untuk membagikan playlist.'); if (typeof openLogin === 'function') openLogin(); return }
  if (!p.songs.length) { say('Playlist masih kosong — tambahkan lagu dulu.'); return }
  pmBusy = true; pmPaint();
  const j = await jpost('/api/auth/pl/share', { pid: p.id, name: p.name, songs: p.songs });
  pmBusy = false;
  if (j && j.ok && j.code) {
    p.pub = j.code; plSave(); pmCopy(p); say('Playlist publik! Link: ' + pmLink(p));
    pmPaint(); paintHome(); if (page && page.key === 'pl:' + p.id) renderPlPage(true)
  } else say((j && j.error) || 'Gagal membagikan playlist');
});
document.addEventListener('pointerdown', e => { if (!pm.hidden && !pm.contains(e.target) && !e.target.closest('[data-dots]') && e.target.id !== 'mupldots') pmClose() });
addEventListener('keydown', e => { if (e.key === 'Escape' && !pm.hidden) { pmClose(); e.stopPropagation() } }, true);

/* ---------- halaman playlist publik (dibuka lewat link /music?pl=KODE) ----------
   Read-only: putar / acak / salin seluruhnya ke playlist sendiri. Tanpa login juga bisa. */
let sharedCode = null;
async function openShared(code, play, mine, pid) {
  sharedCode = code;
  page = { key: 'share', title: 'Playlist publik', songs: [], by: '', loading: true, mine: !!mine, pid: String(pid || '') };
  if (active()) render();
  const j = await jget('/api/auth/pl/get?code=' + encodeURIComponent(code) + '&clientId=' + encodeURIComponent(cid));
  if (sharedCode !== code) return; /* user sudah pindah */
  if (!(j && j.ok)) {
    sharedCode = null; page = null;
    say((j && j.error) || 'Playlist tidak ditemukan — mungkin sudah private.'); /* pesan server sudah ramah user (bukan error teknis) */
    if (active()) render();
    return;
  }
  page = { key: 'share', title: String(j.name || 'Playlist'), by: String(j.by || ''), songs: (Array.isArray(j.songs) ? j.songs : []).filter(s => s && s.id), mine: !!mine, pid: String(pid || '') };
  if (active()) render();
  if (play && page.songs.length) playSong(0, page.songs.slice()); /* tombol putar di kartu "Pilihan Orang Lain" */
}
function saveShared() {
  const l = page && page.songs || [];
  if (!l.length) return;
  if (plList().length >= PL_MAX) { say('Maks ' + PL_MAX + ' playlist.'); return }
  /* playlist milik sendiri yang hilang dari perangkat (mis. dulu terhapus saat Keluar): pulihkan dengan id & link publik ASLI,
     jadi tetap playlistmu — bisa diedit dan perubahannya ikut ke link yang sama. Selain itu = salinan baru biasa. */
  const keep = !!(page.mine && sharedCode && /^[\w-]{1,40}$/.test(page.pid || '') && page.pid !== LIKED && !plGet(page.pid));
  const np = { id: keep ? page.pid : plNewId(), name: String(page.title || 'Playlist').slice(0, 60), songs: l.slice(0, PL_SONGS) };
  if (keep) np.pub = sharedCode;
  plList().push(np);
  if (!plSave()) { say('Gagal menyimpan: penyimpanan browser penuh.'); return }
  say(keep ? 'Playlist dipulihkan: ' + np.name : 'Disalin ke playlist kamu: ' + np.name);
  if (sharedCode) { /* catat kode yang sudah disalin ke perangkat ini ('mplrest'): kartu "Kamu" milik
     sendiri di Pilihan Orang Lain tidak perlu tampil lagi (isi playlistnya sudah ada di lokal) */
    try { const a = JSON.parse(store.get('mplrest') || '[]'); if (Array.isArray(a) && !a.includes(sharedCode)) store.set('mplrest', JSON.stringify(a.concat(sharedCode).slice(-40))) } catch {}
  }
  openPl(np.id);
}
function renderSharePage(keepY) {
  const y = keepY && $('music') ? $('music').scrollTop : 0, c = cur(), l = page.songs, pl0 = { id: 'share', songs: l };
  recLists['share'] = l;
  body.innerHTML =
    '<div class="mu-ptw"><button type="button" class="mu-ptog" id="muptog" aria-label="Tampilkan pemutar" title="Tampilkan pemutar">' + SVG.panel + '</button></div>' +
    '<div class="mu-pgh"><button type="button" class="mu-back" id="muback" aria-label="Kembali">' + CHEV + '</button></div>' +
    '<div class="mu-plh"><div class="mu-plc">' + covInner(pl0) + '</div><div class="mu-plm"><small>Playlist publik' + (page.by ? ' · oleh @' + esc(page.by) : '') + (page.mine ? ' (kamu)' : '') + '</small><h1>' + esc(page.title) + '</h1>' +
    '<p>' + plSub(pl0) + (l.length ? ' · ' + fmtLong(plDur(pl0)) : '') + '</p></div></div>' +
    '<div class="mu-pla"><button type="button" class="mupl-play big" id="mushplay" aria-label="Putar playlist"' + (l.length ? '' : ' disabled') + '>' + SVG.play + '</button>' +
    '<button type="button" class="mu-plb" id="mushsh" aria-label="Putar acak" title="Putar acak"' + (l.length ? '' : ' disabled') + '>' + SVG.shuffle + '</button>' +
    '<button type="button" class="mu-plb wide" id="mushsave" aria-label="Simpan ke playlist saya" title="Simpan ke playlist saya"' + (l.length ? '' : ' disabled') + '>' + SVG.plus + '<span>Simpan ke playlist saya</span></button></div>' +
    (l.length ? '<div class="mu-trs" id="mushtrs">' + l.map((s, i) =>
      '<div class="mu-tr' + (c && c.id === s.id ? ' now' : '') + '" data-i="' + i + '" role="button" tabindex="0">' +
      '<span class="n">' + (c && c.id === s.id ? '<span class="mu-eq" aria-label="Sedang diputar"><i></i><i></i><i></i></span>' : i + 1) + '</span>' +
      '<img src="' + esc(s.thumb || '') + '" alt="" loading="lazy">' +
      '<span class="si"><b>' + esc(s.title || s.id) + '</b><span>' + esc(s.artist || '—') + '</span></span>' +
      '<span class="al">' + esc(s.album || '') + '</span><span class="dur">' + fmt(s.dur) + '</span></div>').join('') + '</div>'
      : '<div class="mu-msg">' + (page.loading ? SPIN + ' Memuat playlist…' : 'Playlist ini kosong.') + '</div>');
  if ($('music')) $('music').scrollTop = y;
  $('muback').addEventListener('click', closePage);
  $('muptog').addEventListener('click', () => setPanel(true));
  $('mushplay').addEventListener('click', () => { if (l.length) playSong(0, l.slice()) });
  $('mushsh').addEventListener('click', () => { if (!l.length) return; shuffle = true; save(); playSong(Math.floor(Math.random() * l.length), l.slice()) });
  $('mushsave').addEventListener('click', saveShared);
  const t = $('mushtrs');
  if (t) t.addEventListener('click', e => { const row = e.target.closest('.mu-tr'); if (row) { const i = +row.dataset.i; playSong(0, l.slice(i).concat(l.slice(0, i))) } });
}

/* ---------- Pilihan Orang Lain: playlist publik (beranda, satu baris carousel) ----------
   Sumber /api/auth/pl/list (koleksi music_pl): judul = nama playlist, artis = @nama pembuat.
   Klik kartu -> halaman playlist publik yang sudah ada (openShared); tombol putar -> langsung putar semua.
   Entri milik sendiri (mine:true dari token) yang playlist lokalnya masih ada disembunyikan di sini
   (biar tidak dobel dengan "Playlist kamu"); yang lokalnya hilang TETAP tampil ber-badge "Kamu" —
   dulu semua entri sendiri disaring di server, jadi pemilik tidak bisa melihat playlist publiknya
   sendiri dari perangkat yang localStorage-nya kosong. */
let opl = null, oplBusy = false; /* opl = { t, pls:[{code,name,by,n,cover,pid,mine}] }; muat sekali per menit */
const jgetAuth = async url => { try { const hd = {}; if (typeof atok === 'string' && atok) hd.Authorization = 'Bearer ' + atok; const r = await fetch(url, { headers: hd }); return await r.json() } catch { return { error: 'Gagal menghubungi server' } } };
async function loadOpl() {
  if (oplBusy || (opl && Date.now() - opl.t < 60e3)) return;
  oplBusy = true;
  const j = await jgetAuth('/api/auth/pl/list?clientId=' + encodeURIComponent(cid));
  oplBusy = false;
  if (j && j.ok && Array.isArray(j.pls)) opl = { t: Date.now(), pls: j.pls.filter(p => p && p.code && p.name).slice(0, 20) };
  if (active()) paintHome();
}
/* kode publik milik sendiri yang sudah pernah disalin ke "Playlist kamu" di perangkat ini */
const restCodes = () => { try { const a = JSON.parse(store.get('mplrest') || '[]'); return new Set(Array.isArray(a) ? a.filter(x => typeof x === 'string') : []) } catch { return new Set() } };
function oplSecHtml() {
  if (!opl || !opl.pls.length) return '';
  const local = plList(), localId = new Set(local.map(p => p.id)), localPub = new Set(local.filter(p => p.pub).map(p => p.pub)), rest = restCodes();
  const pls = opl.pls.filter(p => !(p.mine && ((p.pid && localId.has(p.pid)) || localPub.has(p.code) || rest.has(p.code))));
  if (!pls.length) return '';
  return '<section class="mu-sec" data-sec="opl"><div class="mu-shr"><div class="mu-sht"><div><small>Dibagikan pengguna lain</small><h2>Pilihan Orang Lain</h2></div></div></div>' +
    '<div class="mu-rw"><div class="mu-grid">' + pls.map(p =>
      '<button type="button" class="mu-card" data-opl="' + esc(p.code) + '"><span class="cv">' +
      (p.cover ? '<img src="' + esc(p.cover) + '" alt="" loading="lazy" draggable="false">' : '<span class="mu-note">' + SVG.note + '</span>') +
      '<span class="pp" aria-hidden="true">' + SVG.play + '</span></span>' +
      '<b class="t">' + esc(p.name) + '</b><span class="a">' + (p.mine ? '<span class="mu-mine">Kamu</span>' : '') + 'oleh @' + esc(p.by || 'tanpa-nama') + (p.n ? ' · ' + p.n + ' lagu' : '') + '</span></button>').join('') + '</div>' +
    '<button type="button" class="mu-arr l" data-arr="-1" aria-label="Geser ke kiri" hidden>' + CHEV + '</button>' +
    '<button type="button" class="mu-arr r" data-arr="1" aria-label="Geser ke kanan" hidden>' + CHEV + '</button></div></section>';
}

/* ---------- lagu tersimpan di server (permanen): hasil import link YouTube ----------
   Sumber: /api/music/library (proxy ke server Ptero). Lagu di sini TIDAK pernah hangus — diputar
   lewat jalur biasa, server memakai file permanen dulu sebelum cache. srvOn=false = Ptero belum
   diset (seksi disembunyikan); srvOn=true tapi srv null = masih dimuat. */
let srv = null, srvOn = null, srvBusy = false; /* srv = {t, songs, total, kuota}; srvOn: null belum dicek / true / false */
const fmtMB = b => !b ? '' : (b / 1048576 >= 1 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
async function loadSrv(force) {
  if (srvOn === false || srvBusy) return;
  if (!force && srv && Date.now() - srv.t < 60e3) return;
  srvBusy = true;
  const j = await jget('/api/music/library?clientId=' + encodeURIComponent(cid));
  srvBusy = false;
  if (j && j.ok && Array.isArray(j.songs)) { srv = { t: Date.now(), songs: j.songs, total: j.total_bytes || 0, kuota: j.kuota_bytes || 0 }; srvOn = true }
  else if (j && (j.code === 'butuh_ptero' || j.need_ptero)) srvOn = false; /* Ptero belum diset: sembunyikan seksi */
  /* error lain (server mati dsb.): coba lagi nanti, tampilkan data lama kalau ada */
  if (active()) { paintHome(); if (page && page.key === 'srv') renderPage() }
}
function srvSecHtml() {
  if (!srvOn || !srv || !srv.songs.length) return '';
  recLists['srv'] = srv.songs;
  return '<section class="mu-sec" data-sec="srv"><div class="mu-shr"><div class="mu-sht"><div><small>Permanen di data server</small><h2>Lagu tersimpan di server</h2></div></div>' +
    '<button type="button" class="mu-more" data-more="srv">Lihat semua</button></div>' +
    '<div class="mu-rw"><div class="mu-grid">' + srv.songs.map((s, i) => cardHtml(s, 'srv', i)).join('') + '</div>' +
    '<button type="button" class="mu-arr l" data-arr="-1" aria-label="Geser ke kiri" hidden>' + CHEV + '</button>' +
    '<button type="button" class="mu-arr r" data-arr="1" aria-label="Geser ke kanan" hidden>' + CHEV + '</button></div></section>';
}
/* halaman "Lihat semua" versi server: baris ala playlist + tombol hapus (ketuk 2x) + status unduhan */
let srvArm = 0;
function renderSrvPage(keepY) {
  if (!srv) { page = null; render(); return }
  const y = keepY && $('music') ? $('music').scrollTop : 0, c = cur(), l = srv.songs;
  body.innerHTML =
    '<div class="mu-ptw"><button type="button" class="mu-ptog" id="muptog" aria-label="Tampilkan pemutar" title="Tampilkan pemutar">' + SVG.panel + '</button></div>' +
    '<div class="mu-pgh"><button type="button" class="mu-back" id="muback" aria-label="Kembali">' + CHEV + '</button></div>' +
    '<div class="mu-plh"><div class="mu-plc"><span class="mu-note">' + SVG.note + '</span></div><div class="mu-plm"><small>Server · permanen</small><h1>Lagu tersimpan di server</h1>' +
    '<p>' + l.length + ' lagu' + (srv.total ? ' · ' + fmtMB(srv.total) + (srv.kuota ? ' dari ' + fmtMB(srv.kuota) : '') : '') + ' — hasil import link YouTube, tidak pernah hangus.</p></div></div>' +
    '<div class="mu-pla"><button type="button" class="mupl-play big" id="msrvplay" aria-label="Putar semua"' + (l.length ? '' : ' disabled') + '>' + SVG.play + '</button>' +
    '<button type="button" class="mu-plb" id="msrvsh" aria-label="Putar acak" title="Putar acak"' + (l.length ? '' : ' disabled') + '>' + SVG.shuffle + '</button></div>' +
    (l.length ? '<div class="mu-trs" id="msrvtrs">' + l.map((s, i) =>
      '<div class="mu-tr' + (c && c.id === s.id ? ' now' : '') + '" data-i="' + i + '" role="button" tabindex="0">' +
      '<span class="n">' + (c && c.id === s.id ? '<span class="mu-eq" aria-label="Sedang diputar"><i></i><i></i><i></i></span>' : i + 1) + '</span>' +
      '<img src="' + esc(s.thumb || '') + '" alt="" loading="lazy">' +
      '<span class="si"><b>' + esc(s.title || s.id) + '</b><span>' + esc(s.artist || '—') + '</span></span>' +
      '<span class="al">' + (s.status === 'ok' ? (s.size || '') : s.status === 'downloading' ? 'mengunduh…' : 'gagal') + '</span>' +
      '<span class="dur">' + fmt(s.dur) + '</span>' +
      '<span class="rm" role="button" tabindex="0" data-del="' + esc(s.id) + '" title="Hapus dari server" aria-label="Hapus ' + esc(s.title || s.id) + ' dari server">' + SVG.trash + '</span></div>').join('') + '</div>'
      : '<div class="mu-msg">Belum ada lagu tersimpan. Tempel link YouTube di kolom cari untuk mengimpornya permanen ke server.</div>');
  if ($('music')) $('music').scrollTop = y;
  $('muback').addEventListener('click', closePage);
  $('muptog').addEventListener('click', () => setPanel(true));
  $('msrvplay').addEventListener('click', () => { if (l.length) playSong(0, l.slice()) });
  $('msrvsh').addEventListener('click', () => { if (!l.length) return; shuffle = true; save(); playSong(Math.floor(Math.random() * l.length), l.slice()) });
  const t = $('msrvtrs');
  if (t) t.addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      const id = del.dataset.del, s = l.find(x => x.id === id);
      if (!srvArm) { /* ketuk 2x untuk hapus (pola yang sama dengan hapus playlist) */
        srvArm = setTimeout(() => { srvArm = 0; const b = document.querySelector('[data-del="' + id + '"]'); if (b) { b.classList.remove('arm'); b.title = 'Hapus dari server' } }, 3000);
        del.classList.add('arm'); del.title = 'Tap lagi untuk menghapus';
        say('Tap sekali lagi untuk menghapus dari server: ' + (s ? (s.title || id) : id));
        return;
      }
      clearTimeout(srvArm); srvArm = 0;
      rmSrv(id, s ? s.title : '');
      return;
    }
    const row = e.target.closest('.mu-tr');
    if (row) { const i = +row.dataset.i; playSong(0, l.slice(i).concat(l.slice(0, i))) }
  });
}
async function rmSrv(id, title) {
  const j = await jget('/api/music/library/remove?id=' + encodeURIComponent(id) + '&clientId=' + encodeURIComponent(cid));
  if (j && j.ok) { say('Dihapus dari server: ' + (title || id)); loadSrv(true) }
  else say((j && j.error) ? tech(j.error) : 'Gagal menghapus dari server');
}

/* ---------- render: layar pencarian ---------- */
function render() {
  if (!active()) return;
  if (page) { renderPage(); return }
  body.innerHTML =
    '<div class="mu-ptw"><button type="button" class="mu-ptog" id="muptog" aria-label="Tampilkan pemutar" title="Tampilkan pemutar">' + SVG.panel + '</button></div>' +
    '<div class="mu-top"><h1>Musik</h1><p class="mu-sub">Cari lagu dan dengarkan langsung — tetap bisa jalan sambil ngobrol di tab lain.<small>Sumber audio: YouTube Music · Lirik: LRCLIB</small></p></div>' +
    '<form class="mu-srch" id="musrch"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>' +
    '<input id="muq" type="search" placeholder="Judul lagu, artis, album, atau link YouTube…" autocomplete="off" enterkeyhint="search" aria-label="Cari lagu atau tempel link YouTube">' +
    '<button class="mu-go" type="submit" id="mugo" aria-label="Cari">' + SVG.search.replace('<svg ', '<svg class="mu-goi" ') + '</button><div class="mu-hist" id="muhist" role="listbox" aria-label="Riwayat pencarian" hidden></div></form>' +
    '<div id="muhome"></div><div id="mures"></div>';
  const inp = $('muq'), res = $('mures');
  $('musrch').addEventListener('submit', e => { e.preventDefault(); doSearch(inp.value) });
  histInit(inp);
  /* kolom dikosongkan (termasuk tombol x) -> kembali ke beranda rekomendasi */
  inp.addEventListener('input', () => { if (!inp.value && searched) { searched = false; searching = false; songs = []; imp = null; lastErr = ''; window.muLastQ = ''; render(); $('muq').focus() } });
  $('muhome').addEventListener('click', onHome);
  $('muptog').addEventListener('click', () => setPanel(true));
  $('muhome').addEventListener('scroll', e => { const g = e.target; if (g.classList && g.classList.contains('mu-grid')) updateArrows(g.closest('.mu-sec')) }, true); /* scroll tidak bubble: pakai capture */
  if (searching) res.innerHTML = imp ? impCard() : Array.from({ length: 6 }).map(() => '<div class="mu-skel"><div class="a"></div><div class="b"><i></i><i></i></div></div>').join('');
  else if (searched) res.innerHTML = imp ? impCard() : renderResults();
  res.addEventListener('click', onResults);
  if (inp && window.muLastQ) inp.value = window.muLastQ;
  paintHome();
  if (!searching && !searched) loadRec();
  if (srvOn !== false) loadSrv(); /* seksi "Lagu tersimpan di server": muat sekali per menit */
  loadOpl(); /* seksi "Pilihan Orang Lain": playlist publik pengguna lain, muat sekali per menit */
}

/* segarkan HANYA daftar hasil (tanpa membongkar kolom cari: fokus & teks ketikan tidak hilang) */
function paintResults() {
  const res = $('mures');
  if (!res || !active()) return;
  if (imp) { res.innerHTML = impCard(); return }
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
  const ib = e.target.closest('[data-imp]');
  if (ib) { /* kartu import: putar / antrean / coba lagi */
    if (!imp) return;
    const act = ib.dataset.imp;
    if (act === 'retry') { doImport(imp.id, imp.url); return }
    if (!imp.song) return;
    if (act === 'play') { playSong(0, [imp.song]); return }
    if (act === 'queue') { queue.push(imp.song); save(); say('Ditambahkan ke antrean: ' + (imp.song.title || imp.song.id)); if (sheet) renderSheet() }
    return;
  }
  const add = e.target.closest('[data-add]');
  if (add) { e.stopPropagation(); const i = +add.dataset.add; queue.push(songs[i]); save(); say('Ditambahkan ke antrean: ' + songs[i].title); if (sheet) renderSheet(); return }
  const row = e.target.closest('.mu-song');
  if (row) playFromResults(+row.dataset.i);
}

/* ---------- riwayat pencarian: muncul di bawah kolom cari saat difokus/diketik ----------
   Disimpan di perangkat ('mqhist', 12 terbaru, tanpa duplikat). Link YouTube tidak dicatat.
   Klik = cari lagi, x = hapus satu, "Hapus semua"; keyboard: ↑/↓ lalu Enter, Esc menutup. */
const QH_KEY = 'mqhist', QH_MAX = 12;
const qhGet = () => { try { const a = JSON.parse(store.get(QH_KEY) || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string' && x).slice(0, QH_MAX) : [] } catch { return [] } };
const qhSet = a => { try { store.set(QH_KEY, JSON.stringify(a.slice(0, QH_MAX))) } catch { } };
function qhAdd(q) { qhSet([q, ...qhGet().filter(x => x.toLowerCase() !== q.toLowerCase())]) }
function histInit(inp) {
  const box = $('muhist'); if (!box) return;
  let sel = -1;
  const rows = () => [...box.querySelectorAll('.mu-hi')];
  const hide = () => { box.hidden = true; sel = -1 };
  const paint = () => {
    const v = inp.value.trim().toLowerCase(), all = qhGet();
    const list = (v ? all.filter(x => x.toLowerCase().includes(v) && x.toLowerCase() !== v) : all).slice(0, 8);
    sel = -1;
    if (!list.length) { box.hidden = true; box.innerHTML = ''; return }
    box.innerHTML = '<div class="mu-hh"><span>' + (v ? 'Cocok di riwayat' : 'Pencarian terakhir') + '</span>' + (v ? '' : '<button type="button" data-clr>Hapus semua</button>') + '</div>' +
      list.map(q => '<div class="mu-hi" role="option" data-q="' + esc(q) + '">' + SVG.clock + '<span>' + esc(q) + '</span><button type="button" class="mu-hx" data-del aria-label="Hapus dari riwayat">' + SVG.close + '</button></div>').join('');
    box.hidden = false;
  };
  const pick = q => { inp.value = q; hide(); doSearch(q) };
  const mark = i => { const r = rows(); r.forEach((x, k) => x.classList.toggle('sel', k === i)); sel = i; if (r[i]) r[i].scrollIntoView({ block: 'nearest' }) };
  inp.addEventListener('focus', paint);
  inp.addEventListener('input', paint);
  inp.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== inp) hide() }, 150));
  inp.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (!box.hidden) { hide(); e.preventDefault() } return }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (box.hidden) { if (e.key === 'ArrowDown') paint(); return }
      const n = rows().length; if (!n) return; e.preventDefault();
      mark(e.key === 'ArrowDown' ? (sel + 1) % n : (sel <= 0 ? n - 1 : sel - 1)); return
    }
    if (e.key === 'Enter' && sel >= 0) { const r = rows()[sel]; if (r) { e.preventDefault(); pick(r.dataset.q) } }
  });
  box.addEventListener('mousedown', e => e.preventDefault()); /* fokus tetap di kolom cari saat klik riwayat */
  box.addEventListener('click', e => {
    const t = e.target.closest ? e.target : null; if (!t) return;
    const row = t.closest('.mu-hi');
    if (t.closest('[data-clr]')) { qhSet([]); paint(); return }
    if (t.closest('[data-del]') && row) { const q = row.dataset.q; qhSet(qhGet().filter(x => x !== q)); paint(); return }
    if (row) pick(row.dataset.q);
  });
  $('musrch').addEventListener('submit', hide);
}

async function doSearch(qRaw) {
  const q = String(qRaw || '').trim();
  if (!q) return;
  const link = ytLink(q); /* tempel link YouTube -> impor permanen, bukan pencarian */
  if (link) return doImport(link, q);
  qhAdd(q);
  window.muLastQ = q; lastErr = ''; searching = true; searched = true; imp = null; render();
  const j = await jget('/api/music/search?q=' + encodeURIComponent(q) + '&clientId=' + encodeURIComponent(cid));
  searching = false;
  if (j.error) { lastErr = tech(j.error); songs = [] } else songs = Array.isArray(j.songs) ? j.songs : [];
  render();
}

/* ---------- import lewat link YouTube: lagu disimpan PERMANEN di data server (Ptero) ----------
   Tempel link di kolom cari -> /api/music/import -> server Ptero menyimpan metadata + file audio ke
   folder library permanen (tidak pernah dibersihkan TTL). Unduhan file jalan di latar; kartu di
   bawah memantau statusnya lewat /api/music/library sampai status 'ok'. Lagu yang sudah tersimpan
   diputar lewat jalur biasa (/api/music/stream) — server otomatis memakai file permanen dulu. */
const YT_OK = /^[\w-]{11}$/;
function ytLink(qRaw) { /* salinan logika ytId di lib/music.js (tanpa ID polos: judul pencarian jangan sampai ke-tangkap) */
  let s = String(qRaw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    if (!/^(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(s)) return null;
    s = 'https://' + s;
  }
  let u; try { u = new URL(s) } catch { return null }
  const h = u.hostname.replace(/^www\.|^m\./i, '').toLowerCase();
  if (h === 'youtu.be') { const p = u.pathname.split('/')[1] || ''; return YT_OK.test(p) ? p : null }
  if (h === 'youtube.com' || h === 'music.youtube.com' || h === 'youtube-nocookie.com') {
    const v = u.searchParams.get('v') || '';
    if (YT_OK.test(v)) return v;
    const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([\w-]{11})/);
    return m ? m[2] : null;
  }
  return null;
}
let imp = null; /* {id, url, busy, song, err, ready} */
function impCard() {
  if (!imp) return '';
  if (imp.busy) return '<div class="mu-res-h">Import dari YouTube</div><div class="mu-impc"><div class="row">' +
    '<span class="th spin">' + SPIN + '</span>' +
    '<div class="si"><b>Mengambil lagu dari link…</b><span class="u">' + esc(imp.url) + '</span></div></div></div>';
  if (imp.err) return '<div class="mu-res-h">Import dari YouTube</div><div class="mu-impc err">' +
    '<div class="row"><span class="th no">' + SVG.close + '</span>' +
    '<div class="si"><b>Import gagal</b><span>' + esc(imp.err) + '</span></div></div>' +
    '<div class="btns"><button type="button" class="go" data-imp="retry">Coba lagi</button></div>' +
    (dev() ? '<p class="hint">Pastikan server audio (Ptero) menyala dan env MUSIC_PTERO_URL terpasang di Vercel.</p>' : '') + '</div>'; /* hint env = info teknisi: hanya Mode dev */
  const s = imp.song, ready = imp.ready;
  return '<div class="mu-res-h">Import dari YouTube</div><div class="mu-impc">' +
    '<div class="row"><span class="th"><img src="' + esc(s.thumb || '') + '" alt="" loading="lazy"></span>' +
    '<div class="si"><b>' + esc(s.title || s.id) + '</b><span>' + esc(s.artist || '—') + (s.dur ? ' · ' + fmt(s.dur) : '') + '</span></div>' +
    '<span class="st' + (ready ? ' ok' : ' dl') + '">' + (ready ? SVG.check + 'Tersimpan permanen' : SPIN + 'Mengunduh ke server…') + '</span></div>' +
    '<div class="btns"><button type="button" class="go" data-imp="play">' + SVG.play + 'Putar</button>' +
    '<button type="button" data-imp="queue">' + SVG.plus + 'Antrean</button></div>' +
    '<p class="hint">Tersimpan di data server (permanen) — muncul di seksi “Lagu tersimpan di server” dan bisa diputar kapan pun tanpa unduh ulang.</p></div>';
}
async function doImport(id, url) {
  window.muLastQ = url; lastErr = ''; searching = true; searched = true; songs = [];
  imp = { id, url, busy: true, song: null, err: '', ready: false };
  render();
  const j = await jget('/api/music/import?id=' + encodeURIComponent(id) + '&clientId=' + encodeURIComponent(cid));
  searching = false;
  if (imp && imp.id === id) imp.busy = false;
  if (j && j.ok) {
    imp.song = j.song || null; imp.ready = !!j.ready; imp.sudah = !!j.sudah_ada;
    say(j.sudah_ada ? 'Lagu ini sudah tersimpan di server.' : 'Berhasil diimpor — file disimpan permanen di server.');
    loadSrv(true);
  } else {
    imp.err = (j && j.error) || 'Import gagal';
  }
  if (active() && imp && imp.id === id) render();
  if (imp && imp.id === id && imp.song && !imp.ready) pollImp(id);
}
/* pantau unduhan di server sampai lagu siap (maks ±1 menit); sekaligus menyegarkan seksi lagu server */
async function pollImp(id) {
  for (let n = 0; n < 15; n++) {
    await new Promise(r => setTimeout(r, 4000));
    if (!imp || imp.id !== id || imp.ready || !imp.song) return;
    const j = await jget('/api/music/library?clientId=' + encodeURIComponent(cid));
    if (!(j && j.ok && Array.isArray(j.songs))) continue;
    srv = { t: Date.now(), songs: j.songs, total: j.total_bytes || 0, kuota: j.kuota_bytes || 0 }; srvOn = true;
    const e = j.songs.find(x => x.id === id);
    if (e && e.status === 'ok') {
      imp.ready = true; imp.song = e;
      say('Selesai diunduh ke server: ' + (e.title || id));
      if (active()) { paintResults(); paintHome(); if (page && page.key === 'srv') renderPage() }
      return;
    }
    if (e && e.status === 'error') {
      imp.err = tech(e.error) || 'Gagal mengunduh ke server'; imp.song = null;
      if (active()) { paintResults(); paintHome(); if (page && page.key === 'srv') renderPage() }
      return;
    }
  }
}

/* ---------- pemanasan (prefetch): selagi lagu diputar, 2 lagu berikutnya diminta ke server lebih dulu ----------
   /api/music/stream menyuruh server audio (Pterodactyl) mengunduh & menyimpan filenya di cache (120 mnt), dan request yang sama
   digabung (dedupe). Jadi saat lagunya benar-benar dibuka, balasannya instan. Hasil balasan dibuang; yang berguna cache di server.
   Diminta BERURUTAN (maks 1 unduhan sekaligus dari klien) supaya slot server (MAX_PARALLEL) tidak habis oleh pemanasan,
   dan baru mulai SETELAH lagu yang sedang diputar siap. Pindah lagu = rantai pemanasan lama berhenti. */
const WARM_N = 2, WARM_TTL = 20 * 60e3;
const warm = new Map();               // id lagu -> waktu terakhir diminta (ms)
let plan = [];                        // mode acak: id lagu berikutnya yang sudah dipilih, supaya yang dipanaskan = yang benar-benar diputar
let pfGen = 0, pfRun = -1, pfT = 0;   // pfGen naik tiap pindah lagu (membatalkan rantai lama); pfRun = rantai yang sedang jalan
/* n lagu berikutnya menurut mode saat ini (acak / berurutan / ulangi semua). Ulangi-satu-lagu = tidak ada. */
function upcoming(n) {
  const c = cur();
  if (!c || repeat === 'one') return [];
  if (shuffle && queue.length > 1) {
    plan = plan.filter(id => id !== c.id && queue.some(x => x.id === id));
    while (plan.length < n) {
      const pool = queue.filter(x => x.id !== c.id && !plan.includes(x.id));
      if (!pool.length) break;
      plan.push(pool[Math.floor(Math.random() * pool.length)].id);
    }
    return plan.slice(0, n).map(id => queue.find(x => x.id === id));
  }
  const out = [];
  for (let k = 1; k <= n; k++) {
    let i = qi + k;
    if (i >= queue.length) { if (repeat === 'all') i %= queue.length; else break }
    if (i !== qi && queue[i]) out.push(queue[i]);
  }
  return out;
}
async function prefetch() {
  if (!cur() || loading || !audio.src || pfRun === pfGen) return;
  const g = pfGen; pfRun = g;
  try {
    for (const s of upcoming(WARM_N)) {
      if (g !== pfGen) return;
      const t = warm.get(s.id);
      if (t && Date.now() - t < WARM_TTL) continue;
      warm.set(s.id, Date.now());
      try {
        const r = await fetch('/api/music/stream?id=' + encodeURIComponent(s.id) + '&clientId=' + encodeURIComponent(cid));
        if (!r.ok) warm.set(s.id, Date.now() - WARM_TTL + 60e3); /* gagal (mis. bot check): coba lagi paling cepat 1 menit lagi, jangan spam */
      } catch { warm.set(s.id, Date.now() - WARM_TTL + 60e3) }
    }
  } finally { if (pfRun === g) pfRun = -1 }
}
const schedWarm = () => { clearTimeout(pfT); pfT = setTimeout(prefetch, 800) }; /* antrean/acak/ulang berubah -> hitung ulang */

/* ---------- memutar lagu ---------- */
async function playSong(idx, list) {
  const nq = list || queue;
  const s = nq[idx];
  if (!s) return;
  if (list) { queue = list }
  pfGen++; /* hentikan rantai pemanasan untuk lagu sebelumnya */
  qi = idx; loading = true; lastErr = ''; hadd(s); save(); paintResults(); paintHome(); paintPage(); renderPl(); renderSheet();
  /* lirik dulu (independen dari stream: tetap tampil walau stream diblokir bot-check) */
  lyr = null; lrcIdx = -1; lyrLoading = true; renderLrc();
  jget('/api/music/lyrics?title=' + encodeURIComponent(s.title) + '&artist=' + encodeURIComponent(s.artist) + '&dur=' + (s.dur || 0))
    .then(j => { lyr = j.lyrics ? (j.lyrics.synced && j.lyrics.synced.length ? j.lyrics.synced : j.lyrics.plain ? [{ t: -1, text: j.lyrics.plain }] : null) : null })
    .catch(() => {})
    .finally(() => { lyrLoading = false; renderLrc(); if (trOn) ensureTr(true) });
  let j = await jget('/api/music/stream?id=' + encodeURIComponent(s.id) + '&clientId=' + encodeURIComponent(cid));
  /* 'sabr' = YouTube acak mengirim format tanpa URL (bukan soal IP): ulangi otomatis sampai 2x */
  for (let k = 0; k < 2 && !j.url && j.code === 'sabr' && qi === idx; k++) {
    await new Promise(r => setTimeout(r, 1200));
    j = await jget('/api/music/stream?id=' + encodeURIComponent(s.id) + '&clientId=' + encodeURIComponent(cid));
  }
  if (qi !== idx || cur() !== s) return; /* user sudah pindah lagu selagi menunggu */
  loading = false;
  if (!j.url) {
    lastErr = tech((j.error || 'Stream tidak tersedia') + (j.detail ? ' [' + j.detail + ']' : ''));
    say(lastErr); renderPl(); renderSheet(); return
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
  setTimeout(() => { if (qi === idx) prefetch() }, 1200); /* lagu ini sudah jalan: panaskan 2 lagu berikutnya */
}
function playFromResults(i) { playSong(0, songs.slice(i).concat(songs.slice(0, i))) } /* klik = putar; sisanya mengikuti sebagai antrean */

function next() {
  if (!queue.length) return;
  if (shuffle && queue.length > 1) { /* pakai pilihan yang sudah dipanaskan (lihat upcoming) */
    const u = upcoming(1)[0], k = u ? queue.findIndex(x => x.id === u.id) : -1;
    if (k >= 0 && k !== qi) return playSong(k);
    let n = qi; while (n === qi) n = Math.floor(Math.random() * queue.length); return playSong(n)
  }
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
  const c = cur(), b = $('muadd'), on = !!c && plHas(plGet(LIKED), c.id);
  b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  b.innerHTML = on ? SVG.check : SVG.plus;
  b.title = on ? 'Tersimpan — klik untuk pilih playlist' : 'Simpan ke Lagu disukai';
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
/* tombol + (kolom kiri bar bawah, tidak ikut kolom tengah): belum tersimpan -> klik = simpan ke "Lagu disukai" (jadi centang);
   sudah centang -> klik = buka popup pilih playlist (di sana juga bisa dihapus dari playlist). */
function quickLike() {
  const c = cur(); if (!c) return;
  const p = plGet(LIKED), has = plHas(p, c.id);
  if (has) p.songs = p.songs.filter(x => x.id !== c.id);
  else if (p.songs.length >= PL_SONGS) { say('Lagu disukai penuh (maks ' + PL_SONGS + ').'); return }
  else p.songs.push(slim(c));
  if (!plSave()) { say('Gagal menyimpan: penyimpanan browser penuh.'); paintAdd(); return }
  say(has ? 'Dihapus dari Lagu disukai: ' + c.title : 'Ditambahkan ke Lagu disukai: ' + c.title);
  paintAdd(); paintHome(); paintPage();
}
$('muadd').addEventListener('click', e => {
  e.stopPropagation();
  const c = cur(); if (!c) return;
  if (!pk.hidden) { pkClose(); return }
  if (plHas(plGet(LIKED), c.id)) pkOpen(); else quickLike();
});

/* ---------- popup "Tambahkan ke playlist": perubahan ditampung dulu, baru berlaku saat Simpan ---------- */
const pk = document.createElement('div'); pk.id = 'mupk'; pk.hidden = true; pk.setAttribute('role', 'dialog'); pk.setAttribute('aria-label', 'Tambahkan ke playlist');
pk.innerHTML = '<div class="pk-h">Tambahkan ke playlist</div>' +
  '<label class="pk-s">' + SVG.search + '<input id="mupkq" type="search" placeholder="Cari playlist" autocomplete="off" aria-label="Cari playlist"></label>' +
  '<button type="button" class="pk-new" id="mupknew">' + SVG.plus + '<span>Playlist baru</span></button>' +
  '<div class="pk-l" id="mupkl"></div>' +
  '<div class="pk-f"><button type="button" id="mupkc">Batal</button><button type="button" class="go" id="mupks">Simpan</button></div>';
app.append(pk);
let pkSong = null, pkSel = null, pkPend = [];
function pkRows() {
  const q = $('mupkq').value.trim().toLowerCase();
  const all = plList().concat(pkPend).filter(p => !q || p.name.toLowerCase().includes(q));
  $('mupkl').innerHTML = all.length ? all.map(p => { const on = pkSel.has(p.id);
    return '<button type="button" class="pk-r" data-id="' + esc(p.id) + '" role="checkbox" aria-checked="' + on + '"><span class="pk-c">' + covInner(p) + '</span>' +
      '<span class="pk-n"><b>' + esc(p.name) + '</b><small>' + plSub(p) + '</small></span><span class="pk-ck' + (on ? ' on' : '') + '">' + (on ? SVG.check : '') + '</span></button>' }).join('')
    : '<div class="pk-e">Playlist tidak ditemukan.</div>';
}
function pkOpen(song, at) {
  const c = song || cur(); if (!c) return;
  pkSong = c; pkPend = [];
  pkSel = new Set(plList().filter(p => plHas(p, c.id)).map(p => p.id));
  $('mupkq').value = ''; pkRows(); pk.hidden = false;
  const w = Math.min(340, innerWidth - 16);
  pk.style.width = w + 'px';
  if (at) { /* dari klik kanan / tekan lama: muncul di titik kursor, dijaga tetap di dalam layar */
    pk.style.bottom = 'auto';
    pk.style.left = Math.max(8, Math.min(at.x, innerWidth - w - 8)) + 'px';
    pk.style.top = Math.max(8, Math.min(at.y, innerHeight - pk.offsetHeight - 8)) + 'px';
  } else { /* dari tombol + di bar bawah: naik ke atas tombol */
    const r = $('muadd').getBoundingClientRect();
    pk.style.top = 'auto';
    pk.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    pk.style.bottom = Math.max(8, innerHeight - r.top + 10) + 'px';
  }
}
function pkClose() { pk.hidden = true; pkSong = null; pkPend = [] }
$('mupkq').addEventListener('input', pkRows);
$('mupkc').addEventListener('click', pkClose);
$('mupknew').addEventListener('click', () => {
  if (plList().length + pkPend.length >= PL_MAX) { say('Maks ' + PL_MAX + ' playlist.'); return }
  const np = { id: plNewId(), name: plNextName(pkPend), songs: [] };
  pkPend.push(np); pkSel.add(np.id); $('mupkq').value = ''; pkRows();
  const l = $('mupkl'); l.scrollTop = l.scrollHeight;
});
$('mupkl').addEventListener('click', e => {
  const r = e.target.closest('.pk-r'); if (!r) return;
  const id = r.dataset.id; pkSel.has(id) ? pkSel.delete(id) : pkSel.add(id); pkRows();
});
$('mupks').addEventListener('click', () => {
  const c = pkSong; if (!c) return;
  const before = plList().map(p => p.songs.slice()); /* untuk membatalkan kalau gagal menyimpan */
  plList().push(...pkPend);
  let n = 0, full = 0, last = '';
  for (const p of plList()) {
    const on = pkSel.has(p.id), has = plHas(p, c.id);
    if (on && !has) { if (p.songs.length >= PL_SONGS) { full++; continue } p.songs.push(slim(c)); n++; last = p.name }
    else if (!on && has) { p.songs = p.songs.filter(x => x.id !== c.id); n++; last = p.name }
  }
  const made = pkPend.length; pkClose();
  if (!plSave()) { say('Gagal menyimpan: penyimpanan browser penuh.'); paintAdd(); paintHome(); paintPage(); return }
  say(full ? 'Sebagian playlist penuh (maks ' + PL_SONGS + ' lagu).' : n + made === 0 ? 'Tidak ada perubahan.' : n === 1 && !made ? 'Playlist diperbarui: ' + last : 'Playlist diperbarui.');
  paintAdd(); paintHome(); paintPage();
});
document.addEventListener('pointerdown', e => { if (!pk.hidden && !pk.contains(e.target) && !$('muadd').contains(e.target)) pkClose() });
/* klik kanan (atau tekan lama di layar sentuh) pada lagu -> langsung popup pilih playlist, tanpa memutar lagunya.
   Berlaku untuk card lagu (beranda & "Lihat semua"), hasil pencarian, dan baris lagu di halaman playlist/server/publik. */
function songAtEl(el) {
  const card = el.closest('.mu-card');
  if (card) {
    if (card.classList.contains('sk') || card.dataset.pl || card.dataset.opl) return null;
    const l = recLists[card.dataset.k]; return l && l[+card.dataset.i] || null;
  }
  const res = el.closest('.mu-song');
  if (res) return songs[+res.dataset.i] || null;
  const row = el.closest('.mu-tr');
  if (row) {
    const box = row.parentElement, i = +row.dataset.i;
    if (box.id === 'mutrs' && page && page.key.startsWith('pl:')) { const p = plGet(page.key.slice(3)); return p && p.songs[i] || null }
    if (box.id === 'mushtrs' && page) return page.songs && page.songs[i] || null;
    if (box.id === 'msrvtrs' && srv) return srv.songs[i] || null;
  }
  return null;
}
function ctxPick(el, x, y) {
  const s = songAtEl(el); if (!s) return false;
  if (!x && !y) { const r = el.getBoundingClientRect(); x = r.left + Math.min(r.width / 2, 120); y = r.top + r.height / 2 } /* tombol keyboard (Shift+F10 / tombol menu) */
  pkOpen(s, { x, y }); return true;
}
document.addEventListener('contextmenu', e => {
  if (!active() || !e.target.closest || !e.target.closest('#music')) return;
  if (rd && rd.touch && e.target.closest('#mutrs')) { e.preventDefault(); return } /* tahan-geser urutan sedang berjalan */
  if (ctxPick(e.target, e.clientX, e.clientY)) e.preventDefault();
});
/* sentuhan: tahan ~0,5 detik; klik sesudahnya ditelan supaya lagu tidak ikut terputar */
let lpT = 0, lpX = 0, lpY = 0, lpDone = 0;
const lpStop = () => { clearTimeout(lpT); lpT = 0 };
document.addEventListener('pointerdown', e => {
  lpStop();
  if (e.pointerType !== 'touch' || !active() || !e.target.closest || !e.target.closest('#music') || !songAtEl(e.target) || rdOk(e.target)) return;
  lpX = e.clientX; lpY = e.clientY; const el = e.target;
  lpT = setTimeout(() => { lpT = 0; if (ctxPick(el, lpX, lpY)) { lpDone = Date.now(); if (navigator.vibrate) try { navigator.vibrate(12) } catch {} } }, 520);
});
document.addEventListener('pointermove', e => { if (lpT && Math.hypot(e.clientX - lpX, e.clientY - lpY) > 10) lpStop() });
document.addEventListener('pointerup', lpStop);
document.addEventListener('pointercancel', lpStop);
document.addEventListener('click', e => { if (lpDone && Date.now() - lpDone < 800) { e.stopPropagation(); e.preventDefault(); lpDone = 0 } }, true);

/* ---------- pindah urutan lagu di playlist sendiri: tahan lalu geser ----------
   Mouse: tekan lalu geser >6px. Sentuhan: tahan ~0,35 detik (HP bergetar), lalu geser; dilepas tanpa geser = popup playlist.
   Baris yang diangkat mengikuti jari, baris lain bergeser memberi celah; urutan baru disimpan saat dilepas.
   Keyboard: Alt+↑ / Alt+↓ pada baris yang fokus. Esc membatalkan saat menggeser. */
let rd = null;
function rdPl() { return page && page.key.startsWith('pl:') ? plGet(page.key.slice(3)) : null }
function rdOk(t) { const p = rdPl(); return !!(p && p.songs.length > 1 && t.closest('#mutrs .mu-tr') && !t.closest('[data-rm]')) }
function rdLayout() {
  const sc = $('music'), delta = (rd.y - rd.y0) + (sc.scrollTop - rd.s0);
  rd.row.style.transform = 'translateY(' + delta + 'px) scale(1.015)';
  const dc = rd.tops[rd.from] + rd.hs[rd.from] / 2 + delta;
  let to = 0; rd.rows.forEach((r, i) => { if (i !== rd.from && rd.tops[i] + rd.hs[i] / 2 < dc) to++ });
  rd.to = to;
  rd.rows.forEach((r, i) => {
    if (i === rd.from) return;
    const d = rd.from < to && i > rd.from && i <= to ? -rd.step : rd.from > to && i >= to && i < rd.from ? rd.step : 0;
    r.style.transform = d ? 'translateY(' + d + 'px)' : '';
  });
}
function rdTick() {
  if (!rd || !rd.on) return;
  if (!rd.row.isConnected) { rdEnd(false); return }
  const sc = $('music'), b = sc.getBoundingClientRect(); let v = 0; /* gulir otomatis di dekat tepi atas/bawah */
  if (rd.y < b.top + 70) v = -Math.ceil((b.top + 70 - rd.y) / 5); else if (rd.y > b.bottom - 70) v = Math.ceil((rd.y - (b.bottom - 70)) / 5);
  if (v) sc.scrollTop += Math.max(-18, Math.min(18, v));
  rdLayout(); rd.raf = requestAnimationFrame(rdTick);
}
function rdStart() {
  if (!rd || rd.on) return; rd.t = 0;
  const rows = [...rd.box.querySelectorAll('.mu-tr')], s0 = $('music').scrollTop;
  if (!rows[rd.from]) { rd = null; return }
  rd.rows = rows; rd.s0 = s0; rd.x0 = rd.x; rd.y0 = rd.y;
  rd.tops = rows.map(r => r.getBoundingClientRect().top + s0); rd.hs = rows.map(r => r.offsetHeight);
  rd.step = rows.length > 1 ? rd.tops[1] - rd.tops[0] : rows[0].offsetHeight;
  rd.on = true; rd.to = rd.from; rd.moved = false;
  rd.box.classList.add('rd-on'); rd.row.classList.add('rd-lift');
  try { rd.row.setPointerCapture(rd.id) } catch { }
  if (rd.touch && navigator.vibrate) try { navigator.vibrate(12) } catch { }
  rdTick();
}
function rdEnd(commit) {
  if (!rd) return;
  const r = rd; rd = null; clearTimeout(r.t); cancelAnimationFrame(r.raf);
  if (!r.on) return;
  r.box.classList.remove('rd-on'); r.row.classList.remove('rd-lift');
  (r.rows || []).forEach(x => { x.style.transform = '' });
  lpDone = Date.now(); /* telan klik setelah lepas supaya lagu tidak terputar */
  try { r.row.releasePointerCapture(r.id) } catch { }
  if (!r.row.isConnected) return;
  if (commit && r.to !== r.from) {
    const [m] = r.p.songs.splice(r.from, 1); r.p.songs.splice(r.to, 0, m);
    if (!plSave()) say('Gagal menyimpan urutan: penyimpanan browser penuh.');
    paintAdd(); renderPlPage(true);
  } else if (commit && r.touch && !r.moved) ctxPick(r.row, r.x, r.y);
}
document.addEventListener('pointerdown', e => {
  if (rd) rdEnd(false);
  if (e.button !== 0 || !active() || !e.target.closest || !rdOk(e.target)) return;
  const row = e.target.closest('#mutrs .mu-tr');
  rd = { row, box: row.parentElement, p: rdPl(), from: +row.dataset.i, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, id: e.pointerId, touch: e.pointerType === 'touch', on: false, moved: false, t: 0 };
  if (rd.touch) rd.t = setTimeout(rdStart, 350);
});
document.addEventListener('pointermove', e => {
  if (!rd || e.pointerId !== rd.id) return;
  rd.x = e.clientX; rd.y = e.clientY;
  const d = Math.hypot(rd.x - rd.x0, rd.y - rd.y0);
  if (!rd.on) { if (rd.touch ? d > 10 : d > 6) { if (rd.touch) { clearTimeout(rd.t); rd = null } else rdStart() } return }
  if (d > 4) rd.moved = true;
});
document.addEventListener('pointerup', e => { if (rd && e.pointerId === rd.id) rdEnd(true) });
document.addEventListener('pointercancel', e => { if (rd && e.pointerId === rd.id) rdEnd(false) });
document.addEventListener('touchmove', e => { if (rd && rd.on) e.preventDefault() }, { passive: false }); /* cegah layar ikut gulir saat menggeser */
document.addEventListener('dragstart', e => { if (e.target.closest && e.target.closest('#mutrs')) e.preventDefault() }); /* cegah seret-gambar bawaan browser */
addEventListener('keydown', e => { if (e.key === 'Escape' && rd && rd.on) { rdEnd(false); e.stopPropagation() } }, true);
document.addEventListener('keydown', e => {
  if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !active() || !e.target.closest) return;
  const row = e.target.closest('#mutrs .mu-tr'), p = rdPl(); if (!row || !p) return;
  const i = +row.dataset.i, j = i + (e.key === 'ArrowUp' ? -1 : 1);
  if (j < 0 || j >= p.songs.length) return;
  e.preventDefault();
  const [m] = p.songs.splice(i, 1); p.songs.splice(j, 0, m);
  if (!plSave()) say('Gagal menyimpan urutan: penyimpanan browser penuh.');
  paintAdd(); renderPlPage(true);
  const nr = $('mutrs') && $('mutrs').querySelector('.mu-tr[data-i="' + j + '"]'); if (nr) nr.focus();
});
addEventListener('keydown', e => { if (e.key === 'Escape' && !pk.hidden) { pkClose(); e.stopPropagation() } }, true);
addEventListener('storage', e => { if (e.key === PL_KEY) { plc = null; paintAdd(); paintHome(); paintPage() } });

/* ---------- dialog "tambah lagu lewat link" di halaman playlist ----------
   Tombol + di halaman playlist -> masukin link YouTube / YouTube Music -> lagu diimpor permanen ke
   server (jalur yang sama dengan import kolom cari), lalu begitu siap otomatis masuk playlist ini.
   Dialog tetap terbuka selama unduhan berjalan; tutup dialog tidak membatalkan unduhan di server. */
const pi = document.createElement('div'); pi.id = 'mupi'; pi.hidden = true; pi.setAttribute('role', 'dialog'); pi.setAttribute('aria-modal', 'true'); pi.setAttribute('aria-label', 'Tambah lagu lewat link');
pi.innerHTML = '<div class="pi-c"><div class="pi-h">Tambah lagu lewat link</div>' +
  '<p class="pi-sub">Tempel link YouTube / YouTube Music — lagunya disimpan permanen di server, lalu langsung masuk playlist <b id="mupipn"></b>.</p>' +
  '<label class="pi-s">' + SVG.link + '<input id="mupiq" type="search" inputmode="url" placeholder="https://youtube.com/watch?v=… atau music.youtube.com/…" autocomplete="off" spellcheck="false" aria-label="Link YouTube"></label>' +
  '<div class="pi-st" id="mupist" hidden></div>' +
  '<div class="pi-f"><button type="button" id="mupib">Batal</button><button type="button" class="go" id="mupigo">Tambah</button></div></div>';
app.append(pi);
let piPl = null, piBusy = false, piGen = 0;
function piSt(html, cls) { const el = $('mupist'); el.hidden = !html; el.className = 'pi-st' + (cls ? ' ' + cls : ''); el.innerHTML = html }
function piOpen(p) {
  piPl = p; piBusy = false; piGen++;
  $('mupipn').textContent = p.name; $('mupiq').value = '';
  piSt(''); $('mupigo').disabled = false; pi.hidden = false;
  setTimeout(() => { try { $('mupiq').focus() } catch {} }, 60);
}
function piClose() { piGen++; piPl = null; pi.hidden = true }
async function piDone(pl, s, sudah, gen) {
  if (gen !== piGen) return;
  if (sudah || plHas(pl, s.id)) piSt(SVG.check + '<span>Sudah ada di playlist ' + esc(pl.name) + '.</span>', 'ok');
  else if (pl.songs.length >= PL_SONGS) { piSt(SVG.close + '<span>Playlist penuh (maks ' + PL_SONGS + ' lagu).</span>', 'err'); piBusy = false; $('mupigo').disabled = false; return }
  else {
    pl.songs.push(slim(s));
    if (!plSave()) { piSt(SVG.close + '<span>Lagu tersimpan di server, tapi playlist gagal disimpan (penyimpanan browser penuh).</span>', 'err'); paintAdd(); paintHome(); paintPage(); piBusy = false; $('mupigo').disabled = false; return }
    piSt(SVG.check + '<span>Tersimpan permanen — masuk playlist ' + esc(pl.name) + '.</span>', 'ok');
    say('Ditambahkan ke ' + pl.name + ': ' + (s.title || s.id));
  }
  paintAdd(); paintHome(); paintPage();
  loadSrv(true);
  piBusy = false; $('mupigo').disabled = false;
  setTimeout(() => { if (piPl === pl && pi.hidden === false) piClose() }, 1400);
}
async function piPoll(gen, pl, id, s) { /* unduhan berjalan di server: pantau lewat /library sampai 'ok' (maks ±1 menit) */
  for (let n = 0; n < 15; n++) {
    await new Promise(r => setTimeout(r, 4000));
    if (gen !== piGen) return;
    const jj = await jget('/api/music/library?clientId=' + encodeURIComponent(cid));
    if (!(jj && jj.ok && Array.isArray(jj.songs))) continue;
    srv = { t: Date.now(), songs: jj.songs, total: jj.total_bytes || 0, kuota: jj.kuota_bytes || 0 }; srvOn = true;
    const e = jj.songs.find(x => x.id === id);
    if (e && e.status === 'ok') { say('Selesai diunduh ke server: ' + (e.title || id)); return piDone(pl, e, false, gen) }
    if (e && e.status === 'error') { piSt(SVG.close + '<span>' + esc(tech(e.error) || 'Gagal mengunduh ke server') + '</span>', 'err'); piBusy = false; $('mupigo').disabled = false; return }
    if (n === 13) piSt(SPIN + '<span>Masih mengunduh — lagu besar butuh waktu. Tutup dialog dan cek seksi “Lagu tersimpan di server” nanti, lagunya tetap lanjut diunduh.</span>', 'busy');
  }
  piSt(SVG.close + '<span>Unduhan masih berjalan di server. Cek “Lagu tersimpan di server” sebentar lagi, lalu tambahkan lewat tombol + lagi.</span>', 'err');
  piBusy = false; $('mupigo').disabled = false;
}
async function piSubmit() {
  if (!piPl || piBusy) return;
  const pl = piPl, raw = $('mupiq').value.trim();
  if (!raw) { piSt(SVG.close + '<span>Tempel link YouTube-nya dulu.</span>', 'err'); $('mupiq').focus(); return }
  const id = ytLink(raw); /* terima youtube.com, youtu.be, music.youtube.com, shorts, live, embed */
  if (!id) { piSt(SVG.close + '<span>Link tidak dikenali. Pakai youtube.com/watch?v=…, youtu.be/…, atau music.youtube.com/watch?v=…</span>', 'err'); return }
  piBusy = true; $('mupigo').disabled = true;
  const gen = ++piGen;
  piSt(SPIN + '<span>Mengambil lagu…</span>', 'busy');
  const j = await jget('/api/music/import?id=' + encodeURIComponent(id) + '&clientId=' + encodeURIComponent(cid));
  if (gen !== piGen) return; /* dialog ditutup saat menunggu: unduhan tetap jalan di server */
  piBusy = false; $('mupigo').disabled = false;
  if (!(j && j.ok)) { piSt(SVG.close + '<span>' + esc(tech((j && j.error) || 'Import gagal — cek server audio (Ptero) menyala.')) + '</span>', 'err'); return }
  const s = j.song || { id, title: '', artist: '', album: '', dur: 0, thumb: '' };
  if (j.ready) { say(j.sudah_ada ? 'Lagu sudah tersimpan di server.' : 'Berhasil diimpor — file disimpan permanen di server.'); return piDone(pl, s, !!j.sudah_ada, gen) }
  piSt(SPIN + '<span><b>' + esc(s.title || id) + '</b> — mengunduh ke server…</span>', 'busy');
  piPoll(gen, pl, id, s);
}
$('mupib').addEventListener('click', piClose);
$('mupigo').addEventListener('click', piSubmit);
$('mupiq').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); piSubmit() } });
pi.addEventListener('pointerdown', e => { if (e.target === pi) piClose() });
addEventListener('keydown', e => { if (e.key === 'Escape' && !pi.hidden) { piClose(); e.stopPropagation() } }, true);

/* volume (disimpan di 'mvol'); tombol speaker = bisukan / bunyikan */
{ const v = parseFloat(store.get('mvol')); if (isFinite(v)) audio.volume = Math.min(1, Math.max(0, v)) }
let lastVol = audio.volume || 1;
const vol2 = $('mnpvol'), volP = $('mnpvolp');
function paintVol() {
  const v = audio.muted ? 0 : audio.volume;
  const ic = v === 0 ? SVG.vol0 : v < .5 ? SVG.vol1 : SVG.vol2;
  for (const s of [vol, vol2]) { s.value = Math.round(v * 100); s.style.setProperty('--v', s.value + '%') }
  volP.textContent = vol2.value;
  $('muvolb').innerHTML = ic; $('mnpvolb').innerHTML = ic;
}
function setVolFrom(s) { audio.muted = false; audio.volume = s.value / 100; if (audio.volume > 0) lastVol = audio.volume; store.set('mvol', String(audio.volume)) }
vol.addEventListener('input', () => setVolFrom(vol));
vol2.addEventListener('input', () => setVolFrom(vol2));
function toggleMute() {
  if (audio.muted || audio.volume === 0) { audio.muted = false; if (audio.volume === 0) audio.volume = lastVol || .7 }
  else { lastVol = audio.volume; audio.muted = true }
  store.set('mvol', String(audio.volume));
}
$('muvolb').addEventListener('click', toggleMute);
$('mnpvolb').addEventListener('click', toggleMute);
/* scroll roda mouse di atas slider panel kanan = naik/turun 5% */
vol2.addEventListener('wheel', e => { e.preventDefault(); vol2.value = Math.min(100, Math.max(0, +vol2.value + (e.deltaY < 0 ? 5 : -5))); setVolFrom(vol2) }, { passive: false });
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
  lrcBox.hidden = lrcW.hidden = sheetTab !== 'lyrics';
  $('mnptr').hidden = sheetTab !== 'lyrics'; /* terjemahan hanya untuk tab Lirik */
  paintSync();
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
/* tanda isi yang sedang tampil di kotak lirik: lagu + status muat + ada/tidaknya terjemahan */
function lrcKey() {
  const c = cur(), tr = trOn && c ? trCache.get(c.id) : null;
  return (c ? c.id : '') + ':' + (lyrLoading ? 'L' : !lyr ? 'N' : lyr.length) + (tr && tr.length ? ':T' : '');
}
function renderLrc() {
  if (!sheet || sheetTab !== 'lyrics') return;
  const c = cur();
  const tr = trOn && c ? trCache.get(c.id) : null; /* terjemahan per baris (kalau nyala & sudah diambil) */
  const key = lrcKey();
  if (key === lrcBuilt && lrcBox.firstChild) return; /* sudah dirender: jangan bongkar (scroll & sorotan ikut hilang tiap play/pause) */
  lrcBuilt = key; lrcIdx = -1; lrcAway = false; lrcHold = 0; paintSync(); /* isi baru -> mulai lagi dari mode ikut lagu */
  const synced = !!(lyr && lyr.length && lyr[0].t >= 0);
  lrcBox.classList.toggle('sync', synced);
  if (lyrLoading) { lrcBox.innerHTML = '<div class="mu-lrc-empty">Mencari lirik…</div>'; return }
  if (!lyr || !lyr.length) { lrcBox.innerHTML = '<div class="mu-lrc-empty">Lirik tidak ditemukan untuk lagu ini.</div>'; return }
  lrcBox.innerHTML = lyr.map((l, i) => '<div class="ln" data-i="' + i + '"' + (l.t < 0 ? ' data-plain="1"' : '') + '>' + esc(l.text) +
    (tr && tr[i] ? '<span class="tr">' + esc(tr[i]) + '</span>' : '') + '</div>').join('');
  lrcStop(); lrcBox.scrollTop = 0;
}
/* ---------- terjemahan lirik (tombol ikon di baris tab; hasil = teks kecil di bawah tiap baris) ----------
   Satu permintaan per lagu (semua baris dikirim sekaligus ke /api/music/translate), cache per lagu
   supaya pindah lagu balik-lalu tidak mengulang. Auto (lagu berganti saat terjemahan nyala) gagal
   = diam saja; lewat klik tombol = toast supaya user tahu. */
async function ensureTr(silent) {
  const c = cur(); if (!c || !lyr || !lyr.length || trBusy || trCache.has(c.id)) return;
  trBusy = true; const b = $('mnptr'); if (b) b.setAttribute('aria-busy', 'true');
  /* gagal (502 dari DeepL / jaringan) = coba LAGI SEKALI setelah 3 dtk — kegagalan sesaat sangat umum (kuota bergulir
     endpoint gratis); tanpa ini terjemahan "mati" sampai ganti lagu. Tidak diulang kalau ditolak karena rate-limit /
     teks kosong (percuma, malah menambah beban) atau kalau lagunya sudah berganti selama menunggu. Server menyimpan
     potongan yang sudah sukses, jadi percobaan ulang murah. */
  const body = { clientId: cid, lang: 'id', text: lyr.map(l => l.text) }, same = () => cur() && cur().id === c.id;
  let j = await jpost('/api/music/translate', body);
  if (!(j && j.ok) && !/Terlalu sering|Tidak ada teks/.test((j && j.error) || '') && same()) {
    await new Promise(z => setTimeout(z, 3000));
    if (same()) j = await jpost('/api/music/translate', body);
  }
  trBusy = false; if (b) b.removeAttribute('aria-busy');
  if (j && j.ok && Array.isArray(j.tr)) {
    trCache.set(c.id, j.tr);
    if (trCache.size > 30) trCache.delete(trCache.keys().next().value); /* jaga memori */
    if (trOn && cur() && cur().id === c.id && !applyTr()) { lrcBuilt = ''; renderLrc() } /* pasang terjemahan di tempat (scroll tidak loncat) */
  } else if (!silent) say((j && j.error) || 'Terjemahan gagal, coba lagi');
}
/* Nyalakan/matikan terjemahan TANPA membongkar daftar lirik. Dulu: innerHTML dibangun ulang + scrollTop = 0, jadi lirik
   loncat ke atas lalu meluncur lagi ke baris aktif. Sekarang teks terjemahan dipasang/dilepas di tempat; tinggi baris
   berubah, jadi satu baris jangkar (baris aktif, atau baris di tengah kotak kalau user sedang menggulir sendiri)
   dijaga tetap di posisi layar yang sama, lalu — kalau sedang ikut lagu — baris aktif digeser halus ke tengah.
   Mematikan: teks memudar dulu (160 ms), baru dilepas. true = ditangani di tempat; false = belum ada baris, render biasa. */
let trAnimT = 0;
function applyTr() {
  if (!sheet || sheetTab !== 'lyrics' || !lyr || !lyr.length || lrcBox.hidden) return false;
  const els = lrcBox.querySelectorAll('.ln');
  if (els.length !== lyr.length) return false;
  clearTimeout(trAnimT); lrcBox.classList.remove('trout');
  const hadTr = !!lrcBox.querySelector('.tr');
  const patch = () => {
    const c = cur(), tr = trOn && c ? trCache.get(c.id) : null;
    const box = lrcBox.getBoundingClientRect(), mid = box.top + box.height / 2;
    let k = (!lrcAway && lrcIdx >= 0 && lrcIdx < els.length) ? lrcIdx : -1;
    if (k < 0) { /* sedang digulir sendiri: jangkar = baris yang paling dekat tengah kotak (yang sedang dibaca) */
      let best = Infinity;
      els.forEach((el, i) => { const r = el.getBoundingClientRect(), d = Math.abs((r.top + r.bottom) / 2 - mid); if (d < best) { best = d; k = i } });
      if (k < 0) k = 0;
    }
    const anchor = els[k], before = anchor.getBoundingClientRect().top - box.top;
    els.forEach((el, i) => {
      const t = el.querySelector('.tr'), txt = tr && tr[i];
      if (txt) { if (!t) { const n = document.createElement('span'); n.className = 'tr in'; n.textContent = txt; el.append(n) } else if (t.textContent !== txt) t.textContent = txt }
      else if (t) t.remove();
    });
    lrcBox.classList.remove('trout');
    lrcBuilt = lrcKey();
    const after = anchor.getBoundingClientRect().top - lrcBox.getBoundingClientRect().top;
    lrcBox.scrollTop += after - before; /* jangkar tidak bergeser sedikit pun */
    if (!lrcAway && lrcIdx >= 0 && lyr[0].t >= 0 && els[lrcIdx]) lrcCenter(els[lrcIdx], true); /* lalu meluncur halus ke tengah */
  };
  if (hadTr && !(trOn && cur() && trCache.has(cur().id))) { lrcBox.classList.add('trout'); trAnimT = setTimeout(patch, 160) }
  else patch();
  return true;
}
/* baris yang sedang dinyanyikan (pencarian biner; +0.25 dtk supaya sorotan sedikit mendahului suara) */
function lrcFind(t) {
  let lo = 0, hi = lyr.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (lyr[mid].t <= t + 0.25) { k = mid; lo = mid + 1 } else hi = mid - 1 }
  return k;
}
/* tengahkan satu baris di dalam kotak lirik. Pakai getBoundingClientRect: offsetTop salah karena kotak ini
   bukan offsetParent langsung (dulu hasilnya melenceng ke posisi di layar, bukan di kotak). */
/* Animasi gulir buatan sendiri (rAF + easing, durasi tetap). Dulu pakai scrollTo({behavior:'smooth'}) bawaan browser:
   di HP tiap pergantian baris memulai ulang animasi dari nol dan durasinya ditentukan browser, jadi terasa kaku/patah-patah. */
function lrcStop() { if (lrcRaf) { cancelAnimationFrame(lrcRaf); lrcRaf = 0 } }
function lrcScrollTo(top, smooth) {
  lrcStop();
  top = Math.max(0, Math.min(top, lrcBox.scrollHeight - lrcBox.clientHeight));
  const from = lrcBox.scrollTop, dist = top - from;
  if (!smooth || Math.abs(dist) < 2 || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) { lrcBox.scrollTop = top; return }
  const dur = Math.min(700, Math.max(380, Math.abs(dist) * 1.1)), t0 = performance.now();
  const step = now => {
    const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3); /* easeOutCubic */
    lrcBox.scrollTop = from + dist * e;
    lrcRaf = p < 1 ? requestAnimationFrame(step) : 0;
  };
  lrcRaf = requestAnimationFrame(step);
}
function lrcCenter(el, smooth) {
  /* offsetTop relatif ke kotak lirik (position:relative) — tanpa memaksa layout ulang lewat getBoundingClientRect */
  const top = el.offsetTop - (lrcBox.clientHeight - el.offsetHeight) / 2;
  lrcScrollTo(top, smooth);
}
/* force = gambar ulang sorotan + loncat langsung (saat lembar dibuka / pindah tab / seek). Selain itu hanya bila baris berganti. */
function syncLrc(force) {
  if (!sheet || sheetTab !== 'lyrics' || !lyr || !lyr.length || lyr[0].t < 0 || lrcBox.hidden) return;
  if (force) { lrcHold = 0; lrcAway = false; paintSync() } /* loncat/seek/buka lembar = ikut lagu lagi */
  const k = lrcFind(audio.currentTime);
  if (k === lrcIdx && !force) return;
  const prev = lrcIdx;
  lrcIdx = k;
  const els = lrcBox.children;
  if (force || prev < 0 || Math.abs(k - prev) > 1 || els.length !== lyr.length) {
    for (let i = 0; i < els.length; i++) { const el = els[i], on = i === k ? 'on' : 'off'; if (el.dataset.lrc !== on) el.dataset.lrc = on; el.classList.toggle('past', i < k) }
  } else { /* pindah 1 baris: cukup sentuh 2 elemen (tidak memicu recalc style ke semua baris) */
    if (els[prev]) { els[prev].dataset.lrc = 'off'; els[prev].classList.add('past') }
    if (els[k]) { els[k].dataset.lrc = 'on'; els[k].classList.remove('past') }
  }
  if (k < 0) { if (force) { lrcStop(); lrcBox.scrollTop = 0 } return }
  if (force || Date.now() > lrcHold) lrcCenter(els[k], !force);
}
const lrcShow = () => { renderLrc(); requestAnimationFrame(() => syncLrc(true)) };
/* user menggulir sendiri (roda / geser jari) -> auto-scroll berhenti SAMPAI tombol Sinkron ditekan (atau klik baris / seek / ganti lagu) */
for (const ev of ['wheel', 'touchstart']) lrcBox.addEventListener(ev, lrcStop, { passive: true });
for (const ev of ['wheel', 'touchmove']) lrcBox.addEventListener(ev, () => {
  lrcStop();
  if (!lyr || !lyr.length || lyr[0].t < 0) return; /* lirik polos tidak punya sinkron */
  lrcAway = true; lrcHold = Infinity; paintSync();
}, { passive: true });
function paintSync() { syncBtn.hidden = !(lrcAway && sheet && sheetTab === 'lyrics' && lyr && lyr.length && lyr[0].t >= 0) }
/* tombol Sinkron: geser mulus kembali ke baris yang sedang dinyanyikan, auto-scroll jalan lagi */
function lrcResync() {
  lrcHold = 0; lrcAway = false; paintSync();
  if (!lyr || !lyr.length || lyr[0].t < 0) return;
  const k = lrcFind(audio.currentTime), el = lrcBox.querySelectorAll('.ln')[k];
  if (k < 0) lrcScrollTo(0, true); else if (el) lrcCenter(el, true);
}
syncBtn.addEventListener('click', lrcResync);
/* Desktop: panel kanan mode "lirik penuh" — cover/kontrol besar disembunyikan, tersisa baris kecil (cover + judul + artis + putar/jeda). Pilihan diingat di 'mfull'. */
let full = false; try { full = store.get('mfull') === '1' } catch {}
function paintFull() {
  np.classList.toggle('full', full);
  const b = $('mnpfull'), t = full ? 'Kembali ke tampilan biasa' : 'Lirik layar penuh';
  b.innerHTML = full ? SVG.shrink : SVG.expand; b.setAttribute('aria-pressed', full ? 'true' : 'false'); b.setAttribute('aria-label', t); b.title = t;
}
$('mnpfull').addEventListener('click', () => { full = !full; store.set('mfull', full ? '1' : '0'); paintFull(); if (sheet && sheetTab === 'lyrics') requestAnimationFrame(() => syncLrc(true)) });
paintFull();
lrcBox.addEventListener('click', e => {
  const ln = e.target.closest('.ln');
  if (ln && ln.dataset.i !== undefined && lyr) { const l = lyr[+ln.dataset.i]; if (l && l.t >= 0) { lrcHold = 0; audio.currentTime = l.t; syncLrc(true) } }
});

/* tab lirik / antrean */
for (const id of ['mnptab-l', 'mnptab-q']) $(id).addEventListener('click', () => { sheetTab = $(id).dataset.t; renderSheet(); if (sheetTab === 'lyrics') lrcShow() });
/* terjemahan lirik: tombol bulat di kanan-bawah area lirik — nyalakan/matikan; teks terjemahan tampil di bawah tiap baris */
$('mnptr').addEventListener('click', () => {
  if (!trOn && !lyrLoading && (!lyr || !lyr.length)) { say('Tidak ada lirik untuk diterjemahkan'); return }
  trOn = !trOn;
  store.set('mlrctr', trOn ? '1' : '0');
  const b = $('mnptr'); b.classList.toggle('on', trOn); b.setAttribute('aria-pressed', trOn ? 'true' : 'false');
  if (!trOn) { if (!applyTr()) { lrcBuilt = ''; renderLrc() } return } /* matikan: teks memudar lalu dilepas, scroll tetap */
  if (cur() && !trCache.has(cur().id)) ensureTr(false); /* belum pernah diterjemahkan -> ambil dulu (dipasang dari ensureTr) */
  else if (!applyTr()) { lrcBuilt = ''; renderLrc() } /* sudah ada cache -> pasang di tempat */
});
if (trOn) { $('mnptr').classList.add('on'); $('mnptr').setAttribute('aria-pressed', 'true') } /* pilihan lama: nyala lagi */
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
function lrcLoop() {
  lrcTick = 0;
  if (audio.paused || audio.ended || document.hidden) return;
  syncLrc(false);
  lrcTick = requestAnimationFrame(lrcLoop);
}
function lrcLoopStart() { if (!lrcTick && !audio.paused) lrcTick = requestAnimationFrame(lrcLoop) }
document.addEventListener('visibilitychange', () => { if (!document.hidden) lrcLoopStart() });
audio.addEventListener('playing', lrcLoopStart);
audio.addEventListener('play', () => { renderPl(); renderSheet(); lrcLoopStart() });
audio.addEventListener('pause', () => { renderPl(); renderSheet() });
audio.addEventListener('ended', () => { if (repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => {}) } else next() });
/* ambil alasan asli dari server (JSON error dari /api/music/audio) lalu tampilkan */
async function explainFail() {
  let msg = 'Gagal memutar lagu ini.';
  try {
    const r = await fetch(audio.src, { headers: { Range: 'bytes=0-1' } });
    if (!r.ok) { const j = await r.json().catch(() => ({})); msg = tech((j.error || 'Server error ' + r.status) + (j.detail ? ' [' + j.detail + ']' : '') + ' — cek /api/music/debug') }
    else msg = tech('Browser tidak bisa memutar format audio ini' + (audio.error ? ' (kode ' + audio.error.code + ')' : '') + '.');
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
addEventListener('shell:tab', () => {
  if (active()) {
    /* navigasi ke link playlist publik saat aplikasi sudah terbuka: /music?pl=KODE */
    const q = new URLSearchParams(location.search).get('pl');
    if (q && !sharedCode && !page) openShared(q.trim().slice(0, 16));
    else render();
    applyPanel(); mCloud() /* tab dibuka: ambil perubahan dari perangkat lain (maks sekali per 30 dtk) */
  } else { sheet = false; np.classList.remove('on') }
});
if (active()) render();
/* link playlist publik dibuka langsung (/music?pl=KODE): tampilkan playlist itu, bukan beranda */
{ const q = new URLSearchParams(location.search).get('pl'); if (q) openShared(q.trim().slice(0, 16)) }
applyPanel();
renderPl();
mCloud(true); /* aplikasi dibuka: tarik playlist, riwayat & antrean dari akun (kalau sudah masuk) */
/* ---------- Desktop: lebar panel kanan bisa diubah dengan menggeser tepi kirinya ----------
   Lebar disimpan di 'mpw' dan dipakai lewat --mnp-w (dibatasi 320px .. 55% lebar layar). Klik dua kali = kembali ke bawaan.
   Keyboard: fokus ke pegangan lalu ←/→. Pegangan hanya tampil di desktop (CSS). */
{
  const h = document.createElement('div');
  h.className = 'mnp-rs'; h.id = 'mnprs'; h.setAttribute('role', 'separator'); h.setAttribute('aria-orientation', 'vertical');
  h.setAttribute('aria-label', 'Ubah lebar pemutar'); h.tabIndex = 0; h.title = 'Geser untuk ubah lebar (klik dua kali untuk reset)';
  np.append(h);
  const LO = 320, hi = () => Math.max(LO, Math.round(innerWidth * .55));
  const setW = w => app.style.setProperty('--mnp-w', 'clamp(' + LO + 'px,' + Math.round(w) + 'px,55vw)');
  const colW = () => np.getBoundingClientRect().width + (parseFloat(getComputedStyle(np).marginRight) || 0);
  const saved = parseInt(store.get('mpw'), 10); if (saved >= LO) setW(saved);
  let rs = null;
  h.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !desk()) return;
    rs = { id: e.pointerId, x: e.clientX, w: colW(), cur: colW() };
    try { h.setPointerCapture(e.pointerId) } catch { }
    app.classList.add('mp-rsz'); e.preventDefault();
  });
  h.addEventListener('pointermove', e => {
    if (!rs || e.pointerId !== rs.id) return;
    rs.cur = Math.min(hi(), Math.max(LO, rs.w + (rs.x - e.clientX))); setW(rs.cur);
  });
  const end = e => {
    if (!rs || e.pointerId !== rs.id) return;
    const w = rs.cur; rs = null; app.classList.remove('mp-rsz');
    try { h.releasePointerCapture(e.pointerId) } catch { }
    store.set('mpw', String(Math.round(w)));
  };
  h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
  h.addEventListener('dblclick', () => { app.style.removeProperty('--mnp-w'); store.set('mpw', '0') });
  h.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const w = Math.min(hi(), Math.max(LO, colW() + (e.key === 'ArrowLeft' ? 24 : -24))); setW(w); store.set('mpw', String(Math.round(w)));
  });
}
/* lebar kolom berubah (panel dibuka/ditutup) tidak memicu 'resize' jendela: pantau #music langsung supaya panah carousel ikut menyesuaikan */
let lastDesk = desk();
addEventListener('resize', () => { const d = desk(); if (d !== lastDesk) { lastDesk = d; applyPanel() } });
if (window.ResizeObserver && $('music')) new ResizeObserver(() => { if (active()) fitRows() }).observe($('music'));

/* konteks untuk mode dev (opsional dipakai lewat konsol) — hanya terpasang saat Mode dev aktif */
const MU_API = { play: playSong, next, prev, queue: () => queue, search: doSearch };
if (dev()) window.MU = MU_API;
/* kejadian 'devmode' (switch Mode dev di Pengaturan): musik tetap jalan untuk semua orang,
   yang berubah hanya konteks konsol dev (window.MU dipasang/lepas). */
addEventListener('devmode', () => {
  if (dev()) { window.MU = MU_API; return }
  try { delete window.MU } catch {}
});
})();
