/* ===== Tab Musik: cari lagu, putar (audio di-proxy server per potongan 1 MB), antrean, lirik =====
   Dimuat setelah shell.js, sebelum router.js (lihat index.html). Server: lib/music.js.
   Memakai global index.html: $, store, cid, app (let/const global, akses langsung).
   Kejadian: 'shell:tab' (dari Shell.setTab) menyegarkan layar saat tabnya tampil.

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
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
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
let loading = false, notice = '', lastErr = '';
let lyr = null, lyrLoading = false; // lirik: [{t, text}] atau null
let sheet = false, sheetTab = 'lyrics';
const cur = () => (qi >= 0 && qi < queue.length ? queue[qi] : null);

/* muat/simpan antrean (pola store seperti pin/logs aplikasi) */
try { const o = JSON.parse(store.get('mqueue') || 'null'); if (o && Array.isArray(o.queue)) { queue = o.queue; qi = Math.min(o.qi ?? -1, o.queue.length - 1); repeat = ['off', 'all', 'one'].includes(o.repeat) ? o.repeat : 'off'; shuffle = !!o.shuffle; } } catch {}
const save = () => store.set('mqueue', JSON.stringify({ queue: queue.slice(0, 100), qi, repeat, shuffle }));

/* ---------- mini player + lembar now playing: dibangun sekali, isi diperbarui ---------- */
const pl = document.createElement('div'); pl.id = 'mupl'; pl.setAttribute('role', 'complementary'); pl.setAttribute('aria-label', 'Pemutar musik');
pl.innerHTML = '<div class="mupb"><i id="mupb-fl"></i></div><div class="mupl-in">' +
  '<img class="art" id="muart" alt="" draggable="false">' +
  '<div class="si" id="musi"><b id="mupt"></b><span id="mupa"></span></div>' +
  '<button type="button" class="mupl-play" id="muplay" aria-label="Putar / jeda">' + SVG.play + '</button>' +
  '<button type="button" class="mupl-nxt" id="munext" aria-label="Lagu berikutnya">' + SVG.next + '</button></div>';
app.append(pl);

const np = document.createElement('div'); np.id = 'mnp'; np.setAttribute('role', 'dialog'); np.setAttribute('aria-label', 'Layar pemutar');
np.innerHTML = '<div class="mnp-in">' +
  '<div class="mnp-top"><button type="button" class="mnp-x" id="mnpx" aria-label="Tutup">' + SVG.close + '</button><span class="t">Sedang diputar</span><span style="width:38px;flex:none"></span></div>' +
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
$('mnpx').addEventListener('click', () => { sheet = false; np.classList.remove('on') });
$('musi').addEventListener('click', () => { sheet = true; np.classList.add('on'); renderSheet() });
$('muart').addEventListener('click', () => $('musi').click());

/* ---------- render: layar pencarian ---------- */
function render() {
  if (!active()) return;
  const c = cur();
  body.innerHTML =
    '<div class="mu-top"><h1>Musik</h1><p class="mu-sub">Cari lagu dan dengarkan langsung — tetap bisa jalan sambil ngobrol di tab lain.<small>Sumber audio: YouTube Music · Lirik: LRCLIB</small></p></div>' +
    '<form class="mu-srch" id="musrch"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>' +
    '<input id="muq" type="search" placeholder="Judul lagu, artis, atau album…" autocomplete="off" enterkeyhint="search" aria-label="Cari lagu">' +
    '<button class="mu-go" type="submit" id="mugo" aria-label="Cari">' + SVG.search.replace('<svg ', '<svg class="mu-goi" ') + '</button></form>' +
    '<div id="mures"></div>';
  const inp = $('muq'), res = $('mures');
  $('musrch').addEventListener('submit', e => { e.preventDefault(); doSearch(inp.value) });
  if (loading) res.innerHTML = Array.from({ length: 6 }).map(() => '<div class="mu-skel"><div class="a"></div><div class="b"><i></i><i></i></div></div>').join('');
  else if (searched) res.innerHTML = renderResults();
  res.addEventListener('click', onResults);
  if (!loading && !searched && !lastErr) res.innerHTML = '<div class="mu-msg">💡 Coba: <b>monokrom tulus</b>, <b>yoasobi racing</b>…</div>';
  if (inp && window.muLastQ) inp.value = window.muLastQ;
}

function renderResults() {
  if (!songs.length) return '<div class="mu-msg">Tidak ada lagu yang cocok. Coba kata kunci lain.</div>';
  const c = cur();
  return '<div class="mu-res-h">' + songs.length + ' lagu ditemukan</div>' + songs.map((s, i) =>
    '<button type="button" class="mu-song' + (c && c.id === s.id ? ' now' : '') + '" data-i="' + i + '">' +
    (c && c.id === s.id ? '<span class="mu-eq" aria-label="Sedang diputar"><i></i><i></i><i></i></span>' : '<img src="' + esc(s.thumb || '') + '" alt="" loading="lazy">') +
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
  window.muLastQ = q; lastErr = ''; loading = true; searched = true; render();
  const j = await jget('/api/music/search?q=' + encodeURIComponent(q) + '&clientId=' + encodeURIComponent(cid));
  loading = false;
  if (j.error) { lastErr = j.error; songs = [] } else songs = Array.isArray(j.songs) ? j.songs : [];
  render();
}

/* ---------- memutar lagu ---------- */
async function playSong(idx, list) {
  const nq = list || queue;
  const s = nq[idx];
  if (!s) return;
  if (list) { queue = list }
  qi = idx; loading = true; lastErr = ''; save(); render(); renderPl(); renderSheet();
  /* lirik dulu (independen dari stream: tetap tampil walau stream diblokir bot-check) */
  lyr = null; lrcIdx = -1; lyrLoading = true; renderLrc();
  jget('/api/music/lyrics?title=' + encodeURIComponent(s.title) + '&artist=' + encodeURIComponent(s.artist) + '&dur=' + (s.dur || 0))
    .then(j => { lyr = j.lyrics ? (j.lyrics.synced && j.lyrics.synced.length ? j.lyrics.synced : j.lyrics.plain ? [{ t: -1, text: j.lyrics.plain }] : null) : null })
    .catch(() => {})
    .finally(() => { lyrLoading = false; renderLrc() });
  const j = await jget('/api/music/stream?id=' + encodeURIComponent(s.id) + '&clientId=' + encodeURIComponent(cid));
  loading = false;
  if (!j.url) {
    lastErr = j.code === 'bot_check' ? 'YouTube menolak dari IP server (bot check) — set env YT_COOKIE di Vercel lalu redeploy. Lihat README-MUSIK.' : (j.error || 'Stream tidak tersedia');
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
  pl.classList.toggle('on', !!s);
  const rb = $('rmusic'); if (rb) rb.classList.toggle('play', !!s && !audio.paused);
  if (!s) return;
  $('muart').src = s.thumb || ''; $('muart').hidden = !s.thumb;
  $('mupt').textContent = s.title;
  $('mupa').textContent = s.artist;
  $('muplay').innerHTML = loading ? SPIN : (audio.paused ? SVG.play : SVG.pause);
  $('muplay').setAttribute('aria-label', audio.paused ? 'Putar' : 'Jeda');
}
$('muplay').addEventListener('click', toggle);
$('munext').addEventListener('click', () => next());

/* ---------- render: lembar now playing ---------- */
function renderSheet() {
  if (!sheet) return;
  const s = cur();
  if (!s) { np.classList.remove('on'); sheet = false; return }
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
  if (lyrLoading) { lrcBox.innerHTML = '<div class="mu-lrc-empty">Mencari lirik…</div>'; return }
  if (!lyr || !lyr.length) { lrcBox.innerHTML = '<div class="mu-lrc-empty">Lirik tidak ditemukan untuk lagu ini.</div>'; return }
  lrcBox.innerHTML = lyr.map((l, i) => '<div class="ln" data-i="' + i + '"' + (l.t < 0 ? ' data-plain="1"' : '') + '>' + esc(l.text) + '</div>').join('');
}
lrcBox.addEventListener('click', e => {
  const ln = e.target.closest('.ln');
  if (ln && ln.dataset.i !== undefined && lyr) { const l = lyr[+ln.dataset.i]; if (l && l.t >= 0) audio.currentTime = l.t }
});

/* tab lirik / antrean */
for (const id of ['mnptab-l', 'mnptab-q']) $(id).addEventListener('click', () => { sheetTab = $(id).dataset.t; renderSheet(); if (sheetTab === 'lyrics') renderLrc() });
$('mnpsh').addEventListener('click', () => { shuffle = !shuffle; save(); renderSheet() });
$('mnprp').addEventListener('click', () => { repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off'; save(); renderSheet(); say(repeat === 'off' ? 'Ulangi mati' : repeat === 'all' ? 'Ulangi semua' : 'Ulangi satu lagu') });
$('mnpplay').addEventListener('click', toggle);
$('mnpnx').addEventListener('click', () => next());
$('mnppv').addEventListener('click', () => prev());

/* ---------- penggeser waktu ---------- */
const seek = $('mnpseek');
function seekP(e) { const r = seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) }
seek.addEventListener('pointerdown', e => { seek.setPointerCapture(e.pointerId); seek.classList.add('drag'); seek.dataset.p = String(seekP(e)); paintTime() });
seek.addEventListener('pointermove', e => { if (seek.classList.contains('drag')) seek.dataset.p = String(seekP(e)); paintTime() });
seek.addEventListener('pointerup', e => { seek.classList.remove('drag'); const p = +(seek.dataset.p || 0); if (audio.duration) audio.currentTime = p * audio.duration; delete seek.dataset.p; paintTime() });

function paintTime() {
  const d = audio.duration || (cur() && cur().dur) || 0;
  let p = seek.classList.contains('drag') ? +(seek.dataset.p || 0) : (d ? Math.min(1, audio.currentTime / d) : 0);
  $('mnpfl').style.width = (p * 100) + '%';
  $('mnpkn').style.left = (p * 100) + '%';
  $('mnpt1').textContent = fmt(audio.currentTime);
  $('mnpt2').textContent = fmt(d);
  seek.setAttribute('aria-valuenow', String(Math.round(p * 100)));
  $('mupb-fl').style.width = (d ? Math.min(1, audio.currentTime / d) * 100 : 0) + '%';
}

/* ---------- peristiwa audio ---------- */
audio.addEventListener('timeupdate', () => {
  paintTime();
  if (lyr && lyr.length && lyr[0].t >= 0 && sheet && sheetTab === 'lyrics') {
    let lo = 0, hi = lyr.length - 1, k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (lyr[mid].t <= audio.currentTime + 0.25) { k = mid; lo = mid + 1 } else hi = mid - 1 }
    if (k !== lrcIdx) {
      lrcIdx = k;
      lrcBox.querySelectorAll('.ln').forEach((el, i) => { el.dataset.lrc = i === k ? 'on' : 'off'; el.classList.toggle('past', i < k) });
      const el = lrcBox.querySelector('.ln[data-lrc="on"]');
      if (el) lrcBox.scrollTo({ top: el.offsetTop - lrcBox.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' });
    }
  }
});
let lrcIdx = -1;
audio.addEventListener('play', () => { renderPl(); renderSheet() });
audio.addEventListener('pause', () => { renderPl(); renderSheet() });
audio.addEventListener('ended', () => { if (repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => {}) } else next() });
/* ambil alasan asli dari server (JSON error dari /api/music/audio) lalu tampilkan */
async function explainFail() {
  let msg = 'Gagal memutar lagu ini.';
  try {
    const r = await fetch(audio.src, { headers: { Range: 'bytes=0-1' } });
    if (!r.ok) { const j = await r.json().catch(() => ({})); msg = (j.code === 'bot_check' ? 'YouTube menolak dari IP server (bot check) — pasang YT_COOKIE di Vercel. Cek /api/music/debug. ' : (j.error || 'Server error ' + r.status) + ' ') }
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
  if (e.key === 'Escape' && sheet) { sheet = false; np.classList.remove('on'); return }
  if (e.code === 'Space' && cur() && !sheet) { e.preventDefault(); toggle() }
});

/* ---------- integrasi shell ---------- */
addEventListener('shell:tab', () => { if (active()) render(); else { sheet = false; np.classList.remove('on') } });
if (active()) render();
renderPl();

/* konteks untuk mode dev (opsional dipakai lewat konsol) */
window.MU = { play: playSong, next, prev, queue: () => queue, search: doSearch };
})();
