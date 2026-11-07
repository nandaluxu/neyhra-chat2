/* ===== Chat Global: UI saja =====
   Dimuat setelah script utama dan group.js, jadi variabel/fungsi global di index.html (app, store, cid, uname, now, dayKey,
   dayLabel, devOn, closeSettings, COARSE) langsung bisa dipakai.

   Pemisahan supaya nanti gampang dihubungkan ke backend:
   - globalchat.mock.js  = satu-satunya sumber data (window.GlobalChatAdapter). Ganti file itu dengan adapter sungguhan.
   - globalchat.js       = hanya menggambar state dan memanggil aksi adapter. Tidak tahu soal jaringan, Redis, WebRTC, atau API.
   Komponen di sini: StatusHeader, Banner, MessageList (Bubble, EmptyView, Skeleton), Composer, InfoSheet, DevSheet. */
(() => {
'use strict';
const A = window.GlobalChatAdapter;
if (!A) return;

const MAX = 256;           // maks karakter per pesan
const GROUP = 5 * 60000;   // pesan beruntun dari pengirim yang sama dalam 5 menit dikelompokkan
const NEAR = 120;          // jarak (px) dari bawah yang dianggap "masih di bawah"

/* ---------- Util ---------- */
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const len = s => [...s].length; // hitung per karakter (emoji = 1), bukan per unit UTF-16
const hue = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const isMine = id => id === cid || id === gcAid(); // pesan lama (sebelum masuk akun) memakai cid; pesan akun memakai id tetap akun, sama di semua browser
// Foto profil pengirim: server mengisi au (username) + av (versi foto) hanya untuk pengirim yang masuk akun. Alamat dibuat di sini dari pola tetap
// (satu domain), bukan dari URL kiriman orang lain, jadi tidak bisa dipakai memuat gambar dari situs luar.
const avUrl = m => /^[a-z0-9_.-]{3,20}$/.test(m.au || '') && Number.isInteger(m.av) && m.av > 0 ? '/api/auth/avatar/' + encodeURIComponent(m.au) + '?v=' + m.av : '';
function addPhoto(node, m) {
  const u = avUrl(m); if (!u) return;
  const im = new Image(); im.alt = ''; im.decoding = 'async'; im.draggable = false; im.referrerPolicy = 'no-referrer';
  im.onerror = () => im.remove(); im.src = u; node.append(im);
}
const selfName = () => (typeof uname === 'string' && uname) || 'Tamu';
const canSend = s => s.status === 'online' || s.status === 'syncing';
A.setSelf(() => ({ id: cid, aid: gcAid(), name: selfName() })); // id = transport (presence/WebRTC, per browser); aid = identitas penulis

const I = {
  back: '<svg viewBox="0 0 24 24"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  sliders: '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M4 12h16M14 6l6 6-6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3"/></svg>',
  sync: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-label="Terkirim"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
  spin: '<svg class="gc-sp" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/></svg>',
  offline: '<svg viewBox="0 0 24 24"><path d="M2 8.8a15 15 0 0 1 4-2.6M22 8.8a15 15 0 0 0-9-3.7M5 12.9a10 10 0 0 1 5-2.7M19 12.9a10 10 0 0 0-2.4-1.9M8.5 16.4a5 5 0 0 1 7 0M12 20h.01M3 3l18 18"/></svg>',
  msg: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  chev: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>'
};

/* ---------- Kerangka DOM ---------- */
app.insertAdjacentHTML('beforeend', `
<section id="gc" aria-label="Chat global" aria-hidden="true">
  <header>
    <button id="gc-back" type="button" title="Kembali" aria-label="Kembali">${I.back}</button>
    <span class="gc-ico" aria-hidden="true">${I.globe}</span>
    <div class="who"><div class="name">Chat Global</div><div class="status gc-status" id="gc-status" data-s="offline" role="status"><span id="gc-stxt">Offline</span></div></div>
    <button id="gc-dev" class="hide" type="button" title="Dev: kelola chat" aria-label="Dev: kelola chat global">${I.sliders}</button>
    <button id="gc-info" type="button" title="Tentang chat global" aria-label="Tentang chat global">${I.info}</button>
  </header>
  <div id="gc-banner" class="gc-banner" role="status" aria-live="polite"></div>
  <main id="gc-list" role="log" aria-live="polite" aria-relevant="additions" aria-label="Percakapan global"></main>
  <div class="gc-foot">
    <div class="gc-meta"><span class="gc-as" id="gc-as"></span><span class="gc-count" id="gc-count" title="Maksimal ${MAX} karakter">0/${MAX}</span></div>
    <div class="gc-row">
      <textarea id="gc-inp" rows="1" placeholder="Pesan untuk semua orang" aria-label="Pesan" aria-describedby="gc-count" autocomplete="off" autocapitalize="sentences"></textarea>
      <button id="gc-send" type="button" title="Kirim" aria-label="Kirim pesan" disabled>${I.send}</button>
    </div>
    <button id="gc-down" type="button" title="Ke pesan terbaru" aria-label="Ke pesan terbaru"><span id="gc-newn" class="hide"></span>${I.down}</button>
    <div id="gc-toast" role="status"></div>
  </div>
</section>
<div id="gc-info-ov" class="gc-ov hide">
  <div class="nbox sbox" role="dialog" aria-labelledby="gc-info-t">
    <div class="shead"><h2 id="gc-info-t">Tentang Chat Global</h2><button id="gc-info-x" type="button" aria-label="Tutup">${I.close}</button></div>
    <div class="sgroup">
      <div class="gc-fact"><b>Satu ruang untuk semua</b><i>Semua pengguna bisa membaca dan mengirim pesan di sini.</i></div>
      <div class="gc-fact"><b>Teks saja</b><i>Maksimal ${MAX} karakter per pesan. Tidak ada gambar maupun file.</i></div>
      <div class="gc-fact"><b>Riwayat ada di perangkatmu</b><i>Riwayat disimpan di perangkat ini, lalu disinkronkan dari pengguna lain saat terhubung.</i></div>
      <div class="gc-fact"><b>Terhubung langsung ke pengguna lain</b><i>Pesan dikirim realtime antar pengguna yang terhubung; server hanya menyimpan beberapa pesan terbaru sebagai cadangan.</i></div>
    </div>
  </div>
</div>
<div id="gc-dev-ov" class="gc-ov hide">
  <div class="nbox sbox" role="dialog" aria-labelledby="gc-dev-t">
    <div class="shead"><h2 id="gc-dev-t">Dev: Chat Global</h2><button id="gc-dev-x" type="button" aria-label="Tutup">${I.close}</button></div>
    <p class="mhelp">Cuma muncul di Mode dev. Penghapusan berlaku untuk semua pengguna dan divalidasi di server (perlu kode dev).</p>
    <div class="sgroup"><h3>Kelola chat</h3>
      <div class="stor"><div class="sl"><span>Pesan di tampilan ini</span><span id="gc-dcount">0</span></div></div>
      <button class="srow danger" id="gc-dclear" type="button"><span><b>Hapus semua pesan</b><i>Mengosongkan seluruh Chat Global. Tap dua kali untuk konfirmasi.</i></span>${I.trash}</button>
      <p class="mhelp" style="margin-top:8px">Hapus satu pesan: tombol tempat sampah muncul di samping tiap bubble selama Mode dev aktif.</p>
    </div>
    <div class="sgroup" id="gc-dsim"><h3>Simulasi tampilan</h3>
      <span class="vlab" style="margin-top:0">Status koneksi</span>
      <div class="seg" id="gc-dseg"><button type="button" data-v="online">Online</button><button type="button" data-v="connecting">Connecting</button><button type="button" data-v="offline">Offline</button><button type="button" data-v="syncing">Syncing</button></div>
      <label class="srow"><span><b>Pesan berikutnya gagal</b><i>Pesan yang kamu kirim berikutnya berakhir "Gagal terkirim".</i></span><input type="checkbox" id="gc-dfail" class="sw"></label>
      <label class="srow"><span><b>"Coba lagi" gagal terhubung</b><i>Menghubungkan ulang berakhir offline.</i></span><input type="checkbox" id="gc-dconn" class="sw"></label>
      <button class="srow" id="gc-dinc" type="button"><span><b>Pesan masuk</b><i>Tambah satu pesan dari pengguna lain.</i></span>${I.chev}</button>
      <button class="srow" id="gc-dreseed" type="button"><span><b>Isi ulang data contoh</b><i>Kembalikan pesan contoh dan status Online.</i></span>${I.chev}</button>
    </div>
  </div>
</div>`);

const gc = $('gc'), list = $('gc-list'), inp = $('gc-inp'), sendB = $('gc-send'), banner = $('gc-banner'),
      cnt = $('gc-count'), as = $('gc-as'), down = $('gc-down'), infoOv = $('gc-info-ov'), devOv = $('gc-dev-ov');
let isOpen = false, started = false, primed = false, unread = 0, bannerKey = '', asKey = '', listKey = '', tT = 0;
const seen = new Set();

function toast(t) { const e = $('gc-toast'); e.textContent = t; e.classList.add('show'); clearTimeout(tT); tT = setTimeout(() => e.classList.remove('show'), 1800); }

/* ---------- StatusHeader (+ titik status di tombol menu) ---------- */
function paintStatus(s) {
  const pct = s.sync && s.sync.total ? Math.round(s.sync.done / s.sync.total * 100) : 0;
  const t = { online: 'Online' + (s.onlineCount ? ' · ' + s.onlineCount + ' aktif' : ''), connecting: 'Menghubungkan…', syncing: 'Sinkronisasi ' + pct + '%', offline: 'Offline' }[s.status];
  $('gc-status').dataset.s = s.status; $('gc-stxt').textContent = t;
}
function paintMenuDot(s) { const d = document.querySelector('#gcbtn .gc-dot'); if (d) d.dataset.s = started ? s.status : 'idle'; }

/* ---------- Banner: menghubungkan, sinkronisasi dari pengguna lain, offline ---------- */
function paintBanner(s) {
  const emptyOff = s.status === 'offline' && !s.messages.length; // tampilan kosong offline sudah punya tombol sendiri
  const show = s.status !== 'online' && !emptyOff;
  banner.classList.toggle('show', show); banner.dataset.s = s.status;
  if (!show) { bannerKey = ''; return; }
  const key = s.status + '|' + (s.error || '');
  if (key !== bannerKey) {
    bannerKey = key;
    if (s.status === 'connecting') banner.innerHTML = `<span class="gc-bi gc-spin">${I.sync}</span><div class="gc-bt"><b>Menghubungkan…</b><small>Mencari pengguna lain untuk terhubung.</small></div>`;
    else if (s.status === 'syncing') banner.innerHTML = `<span class="gc-bi gc-spin">${I.sync}</span><div class="gc-bt"><b>Menyinkronkan riwayat</b><small id="gc-ssub"></small></div><div class="gc-bar"><i id="gc-sbar"></i></div>`;
    else {
      banner.innerHTML = `<span class="gc-bi">${I.offline}</span><div class="gc-bt"><b></b><small>Riwayat di perangkat ini tetap bisa dibaca, tapi kamu belum bisa kirim pesan.</small></div><button class="gc-btn" type="button" data-act="reconnect">Coba lagi</button>`;
      banner.querySelector('b').textContent = s.error || 'Kamu sedang offline';
    }
  }
  if (s.status === 'syncing') {
    const y = s.sync || { done: 0, total: 0, peers: 0 };
    $('gc-ssub').textContent = 'Mengambil dari ' + y.peers + ' pengguna lain · ' + y.done + ' dari ' + y.total + ' pesan';
    $('gc-sbar').style.width = (y.total ? y.done / y.total * 100 : 0) + '%';
  }
}

/* ---------- MessageList ---------- */
function skeleton(s) {
  const w = el('div', 'gc-skwrap');
  w.append(el('p', 'gc-skcap', s.status === 'syncing' ? 'Menunggu riwayat dari pengguna lain…' : 'Menghubungkan…'));
  [[62, 'them'], [44, 'them'], [56, 'me'], [70, 'them'], [38, 'me']].forEach(([p, c]) => { const r = el('div', 'gc-sk ' + c), i = el('i'); i.style.width = p + '%'; r.append(i); w.append(r); });
  return w;
}
function emptyView(s) {
  if (s.status === 'connecting' || s.status === 'syncing') return skeleton(s);
  const d = el('div', 'gc-empty' + (s.status === 'offline' ? ' err' : ''));
  if (s.status === 'offline') {
    d.innerHTML = `<div class="gc-eico">${I.offline}</div><b></b><p>Cek koneksi internetmu, lalu coba lagi. Riwayat chat muncul setelah tersambung.</p><button type="button" data-act="reconnect">Coba lagi</button>`;
    d.querySelector('b').textContent = s.error || 'Nggak bisa terhubung';
  } else {
    d.innerHTML = `<div class="gc-eico">${I.msg}</div><b>Belum ada pesan</b><p>Jadi yang pertama menyapa semua orang di sini.</p><button type="button" data-act="greet">Sapa semua orang</button>`;
  }
  return d;
}
function meta(m, mine) {
  const t = el('div', 'gc-ts');
  if (mine && m.status === 'sending') { t.innerHTML = I.spin; t.append('Mengirim…'); }
  else if (mine && m.status === 'failed') { const b = el('button', 'gc-retry', 'Gagal terkirim · Coba lagi'); b.type = 'button'; b.dataset.retry = m.id; t.append(b); }
  else { t.append(now(m.ts)); if (mine) t.insertAdjacentHTML('beforeend', I.check); }
  return t;
}
function bubble(m, o) {
  const r = el('div', 'gc-msg ' + (o.mine ? 'me' : 'them') + (o.first ? ' first' : '') + (o.last ? ' last' : '') + (o.fresh ? ' new' : '') + (m.status === 'sending' ? ' sending' : '') + (m.status === 'failed' ? ' failed' : ''));
  r.dataset.id = m.id;
  if (!o.mine) { r.style.setProperty('--h', hue(m.senderId)); const av = el('span', o.last ? 'gc-av' : 'gc-av sp', o.last ? [...m.senderName][0] || '?' : ''); av.setAttribute('aria-hidden', 'true'); if (o.last) addPhoto(av, m); r.append(av); }
  const b = el('div', 'gc-b');
  if (!o.mine && o.first) b.append(el('div', 'gc-n', m.senderName));
  b.append(el('div', 'gc-t', m.text), meta(m, o.mine));
  const del = el('button', 'gc-del'); del.type = 'button'; del.dataset.del = m.id; del.title = 'Hapus pesan (dev)'; del.setAttribute('aria-label', 'Hapus pesan ini (dev)'); del.innerHTML = I.trash;
  if (o.mine) r.append(del, b); else r.append(b, del);
  return r;
}
function paintList(s) {
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < NEAR, top = list.scrollTop, msgs = s.messages;
  const frag = document.createDocumentFragment();
  let added = 0, other = 0, mine = 0;
  if (!msgs.length) frag.append(emptyView(s));
  else {
    let lastDay = '';
    msgs.forEach((m, i) => {
      const p = msgs[i - 1], n = msgs[i + 1], dk = dayKey(m.ts);
      if (dk !== lastDay) { lastDay = dk; frag.append(el('div', 'day', dayLabel(m.ts))); }
      const cont = !!p && dayKey(p.ts) === dk && p.senderId === m.senderId && m.ts - p.ts < GROUP;
      const more = !!n && dayKey(n.ts) === dk && n.senderId === m.senderId && n.ts - m.ts < GROUP;
      const isNew = !seen.has(m.id);
      if (isNew) { seen.add(m.id); if (primed) { added++; isMine(m.senderId) ? mine++ : other++; } }
      frag.append(bubble(m, { mine: isMine(m.senderId), first: !cont, last: !more, fresh: primed && isNew }));
    });
  }
  list.replaceChildren(frag);
  if (!primed || mine || (nearBottom && added)) { list.scrollTo({ top: list.scrollHeight, behavior: primed ? 'smooth' : 'auto' }); unread = 0; }
  else { list.scrollTop = top; if (other) unread += other; }
  primed = true; paintDown();
}
function paintDown() {
  const far = list.scrollHeight - list.scrollTop - list.clientHeight > 280;
  if (list.scrollHeight - list.scrollTop - list.clientHeight < NEAR) unread = 0;
  const n = $('gc-newn'); n.classList.toggle('hide', !unread); n.textContent = unread ? unread + ' pesan baru' : '';
  down.classList.toggle('show', far || unread > 0);
}
list.addEventListener('scroll', paintDown, { passive: true });
down.onclick = () => { unread = 0; list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' }); };

/* ---------- Composer ---------- */
function paintAs(force) {
  const s = A.getState(), can = canSend(s), name = selfName(), key = can + '|' + s.status + '|' + name;
  if (!force && key === asKey) return; asKey = key;
  as.textContent = ''; as.className = 'gc-as' + (s.status === 'offline' ? ' off' : '');
  if (can) {
    as.append('Kirim sebagai ', el('b', null, name));
    if (!(typeof uname === 'string' && uname)) { const b = el('button', null, 'masuk'); b.type = 'button'; b.id = 'gc-login'; as.append(' · ', b, ' untuk pakai nama & fotomu'); } // nama + foto = dari Profil
  }
  else as.textContent = s.status === 'connecting' ? 'Menghubungkan · belum bisa kirim' : 'Offline · pesan belum bisa dikirim';
}
function paintComposer(s) {
  s = s || A.getState();
  const n = len(inp.value), can = canSend(s);
  cnt.textContent = n + '/' + MAX; cnt.classList.toggle('warn', n >= MAX - 24 && n < MAX); cnt.classList.toggle('max', n >= MAX);
  sendB.disabled = !can || !inp.value.trim();
  inp.placeholder = can ? 'Pesan untuk semua orang' : s.status === 'connecting' ? 'Menghubungkan…' : 'Offline, pesan belum bisa dikirim';
  paintAs();
}
const grow = () => { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 136) + 'px'; };
function shake(node) { node.classList.remove('shake', 'bump'); void node.offsetWidth; node.classList.add(node === cnt ? 'bump' : 'shake'); }
function clamp(e) { // batas keras 256 karakter, termasuk saat tempel teks panjang
  if (e && e.isComposing) return;
  const a = [...inp.value]; if (a.length > MAX) { inp.value = a.slice(0, MAX).join(''); shake(cnt); }
}
inp.addEventListener('input', e => { clamp(e); grow(); paintComposer(); });
inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !COARSE) { e.preventDefault(); submit(); } }); // HP: Enter = baris baru, seperti chat utama
sendB.addEventListener('pointerdown', e => e.preventDefault()); // tap kirim tidak menutup keyboard
sendB.onclick = submit;
function submit() {
  const s = A.getState(), text = inp.value.replace(/\n{3,}/g, '\n\n').trim();
  if (!text || !canSend(s) || len(text) > MAX) { shake(inp); return; }
  A.send(text); inp.value = ''; grow(); paintComposer();
}
as.addEventListener('click', e => { if (e.target.closest('#gc-login')) { close(); $('setbtn').click(); } });
window.addEventListener('acct', () => paintAs(true)); // masuk/keluar atau nama profil berubah -> label ikut berubah

/* ---------- Aksi dari bubble / banner / tampilan kosong (delegasi klik) ---------- */
const armed = new WeakMap();
gc.addEventListener('click', e => {
  const t = e.target.closest('[data-act],[data-retry],[data-del]'); if (!t) return;
  if (t.dataset.act === 'reconnect') { A.reconnect(); }
  else if (t.dataset.act === 'greet') { inp.value = 'Halo semuanya!'; grow(); paintComposer(); inp.focus(); }
  else if (t.dataset.retry) { if (!canSend(A.getState())) toast('Belum terhubung'); else A.retry(t.dataset.retry); }
  else if (t.dataset.del) { // hapus per pesan (Mode dev): tap dua kali
    if (!devOn()) return;
    if (armed.has(t)) { clearTimeout(armed.get(t)); armed.delete(t); A.deleteMessage(t.dataset.del); toast('Pesan dihapus'); return; }
    t.classList.add('arm'); armed.set(t, setTimeout(() => { armed.delete(t); t.classList.remove('arm'); }, 2500)); toast('Tap lagi untuk hapus pesan');
  }
});

/* ---------- Render utama ---------- */
function render(s, force) {
  paintMenuDot(s);
  if (!isOpen) return;
  paintStatus(s); paintBanner(s); paintComposer(s);
  const key = s.rev + '|' + (s.messages.length ? '' : s.status + (s.error || ''));
  if (force || key !== listKey) { listKey = key; paintList(s); }
  paintDev(s);
}
A.subscribe(s => render(s));

/* ---------- Buka / tutup ---------- */
function open() {
  if (isOpen) return;
  if (!started) { started = true; A.connect(); }
  isOpen = true; nUnread = 0; paintBadge(); hideNote(); gc.classList.add('show'); gc.setAttribute('aria-hidden', 'false');
  syncDev(); primed = false; unread = 0; render(A.getState(), true);
  if (matchMedia('(hover:hover)').matches) setTimeout(() => inp.focus({ preventScroll: true }), 300);
}
function close() { if (!isOpen) return; isOpen = false; gc.classList.remove('show'); gc.setAttribute('aria-hidden', 'true'); inp.blur(); }
$('gcbtn').onclick = open;
$('gc-back').onclick = close;
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!devOv.classList.contains('hide')) { closeOv(devOv); e.stopPropagation(); }
  else if (!infoOv.classList.contains('hide')) { closeOv(infoOv); e.stopPropagation(); }
  else if (isOpen) close();
}, true); // capture: jalan sebelum handler Esc milik menu utama

/* ---------- InfoSheet + DevSheet ---------- */
const openOv = (o, focus) => { o.classList.remove('hide'); setTimeout(() => $(focus).focus(), 50); };
const closeOv = o => o.classList.add('hide');
$('gc-info').onclick = () => openOv(infoOv, 'gc-info-x');
$('gc-info-x').onclick = () => closeOv(infoOv);
infoOv.addEventListener('click', e => { if (e.target === infoOv) closeOv(infoOv); });

/* ---------- Dev Mode (memakai Mode dev yang sudah ada: devOn(), switch di Pengaturan) ---------- */
function syncDev() { const on = devOn(); $('gc-dev').classList.toggle('hide', !on); list.classList.toggle('dev', on); if (!on) closeOv(devOv); }
function openDev() { if (!devOn()) return; if (!started) { started = true; A.connect(); } paintDev(A.getState(), true); openOv(devOv, 'gc-dev-x'); }
$('gc-dev').onclick = openDev;
$('gc-dev-x').onclick = () => closeOv(devOv);
devOv.addEventListener('click', e => { if (e.target === devOv) closeOv(devOv); });
function paintDev(s, force) {
  if (devOv.classList.contains('hide') && !force) return;
  s = s || A.getState();
  $('gc-dcount').textContent = s.messages.length;
  $('gc-dsim').classList.toggle('hide', !A.dev);
  if (!A.dev) return;
  $('gc-dseg').querySelectorAll('button').forEach(b => b.classList.toggle('sel', b.dataset.v === s.status));
  const f = A.dev.flags(); $('gc-dfail').checked = f.failNext; $('gc-dconn').checked = f.failConnect;
}
let clrT = 0;
$('gc-dclear').onclick = () => {
  const b = $('gc-dclear'), lab = b.querySelector('b');
  if (!clrT) { b.classList.add('arm'); lab.textContent = 'Tap lagi untuk hapus SEMUA'; clrT = setTimeout(() => { clrT = 0; b.classList.remove('arm'); lab.textContent = 'Hapus semua pesan'; }, 3000); return; }
  clearTimeout(clrT); clrT = 0; b.classList.remove('arm'); lab.textContent = 'Hapus semua pesan';
  A.clearAll(); toast('Semua pesan dihapus');
};
if (A.dev) {
  $('gc-dseg').onclick = e => { const b = e.target.closest('button'); if (b) A.dev.setStatus(b.dataset.v); };
  $('gc-dfail').onchange = e => A.dev.failNext(e.target.checked);
  $('gc-dconn').onchange = e => A.dev.failConnect(e.target.checked);
  $('gc-dinc').onclick = () => A.dev.incoming();
  $('gc-dreseed').onclick = () => { A.dev.reseed(); toast('Data contoh dikembalikan'); };
}

/* Pengaturan (Mode dev): baris "Kelola Chat Global" di grup Dev yang sudah ada */
const sRow = el('button', 'srow hide'); sRow.type = 'button'; sRow.id = 'gc-sdev';
sRow.innerHTML = `<span><b>Kelola Chat Global</b><i>Hapus pesan dan simulasi status koneksi untuk UI Chat Global.</i></span>${I.chev}`;
$('sdevg').append(sRow);
sRow.onclick = () => { closeSettings(); openDev(); };
$('setbtn').addEventListener('click', () => sRow.classList.toggle('hide', !devOn())); // jalan setelah handler bawaan yang membuka Pengaturan
$('sdev').addEventListener('change', () => { sRow.classList.toggle('hide', !devOn()); syncDev(); });

/* ---------- Notifikasi pesan baru (jalan walau lagi chat dengan karakter / grup) ----------
   Diatur di Pengaturan (switch #sgcn, disimpan di localStorage 'gcn'; default menyala).
   Menyala -> adapter tetap sinkron di latar belakang (A.keepAlive). Pesan dianggap "baru" kalau ts-nya lebih baru dari
   semua pesan yang sudah terlihat, jadi riwayat yang baru ditarik dari peer/Redis tidak memicu notifikasi. */
const NKEY = 'gcn';
let notifOn = store.get(NKEY) !== '0', nReady = false, nMax = 0, nUnread = 0, nBatch = [], nT = 0;
const nSw = $('sgcn');

const note = el('div'); note.id = 'gcnote'; note.setAttribute('role', 'status'); note.setAttribute('aria-live', 'polite');
note.innerHTML = `<span class="gcn-av" aria-hidden="true"></span><span class="gcn-t"><b></b><span></span></span><button type="button" class="gcn-x" aria-label="Tutup notifikasi">${I.close}</button>`;
app.append(note);
const gcBtn = $('gcbtn'), badge = el('i', 'gc-badge hide'); gcBtn.append(badge);

function paintBadge() { badge.classList.toggle('hide', !nUnread || !notifOn); badge.textContent = nUnread > 9 ? '9+' : nUnread; }
function hideNote() { clearTimeout(nT); note.classList.remove('show'); nBatch = []; }
function showNote(fresh) {
  nBatch = nBatch.concat(fresh).slice(-20);
  const last = nBatch[nBatch.length - 1], names = [...new Set(nBatch.map(m => m.senderName))];
  const av = note.querySelector('.gcn-av'); av.style.setProperty('--h', hue(last.senderId)); av.textContent = [...last.senderName][0] || '?'; addPhoto(av, last);
  note.querySelector('b').textContent = names.length === 1 ? names[0] + (nBatch.length > 1 ? ' · ' + nBatch.length + ' pesan' : '') : names[0] + ' +' + (names.length - 1) + ' lainnya · ' + nBatch.length + ' pesan';
  note.querySelector('.gcn-t span').textContent = last.text.replace(/\s+/g, ' ').slice(0, 90);
  note.classList.add('show'); clearTimeout(nT); nT = setTimeout(hideNote, 5500);
}
function sysNote(fresh) { // tab di latar (Android/desktop): notifikasi sistem kalau sudah diizinkan
  try {
    if (!document.hidden || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const m = fresh[fresh.length - 1];
    const n = new Notification('Chat Global · ' + m.senderName, { body: m.text.slice(0, 120), tag: 'neyhra-gc', renotify: true });
    n.onclick = () => { window.focus(); n.close(); openFromNote(); };
  } catch {}
}
function notifyScan(s) {
  const msgs = s.messages;
  if (!nReady) { // baseline: semua yang ada saat pertama online dianggap sudah dilihat
    if (s.status !== 'online') return;
    nReady = true; nMax = msgs.length ? msgs[msgs.length - 1].ts : 0; return;
  }
  const top = msgs.length ? msgs[msgs.length - 1].ts : 0, fresh = [];
  for (const m of msgs) if (m.ts > nMax && !isMine(m.senderId)) fresh.push(m);
  if (top > nMax) nMax = top;
  if (!fresh.length || !notifOn || isOpen) return;
  nUnread += fresh.length; paintBadge(); showNote(fresh); sysNote(fresh);
}
A.subscribe(notifyScan);

function openFromNote() {
  hideNote();
  ['vmodal', 'smodal', 'pmodal', 'mmodal'].forEach(id => { const m = $(id); if (m) m.classList.add('hide'); }); // modal z-index 10 menutupi Chat Global
  open();
}
note.addEventListener('click', e => { if (e.target.closest('.gcn-x')) hideNote(); else openFromNote(); });

function startBg() { if (!started) { started = true; } A.keepAlive(true); }
function setNotif(on, ask) {
  notifOn = on; store.set(NKEY, on ? '1' : '0'); nSw.checked = on;
  if (on) {
    startBg();
    if (ask && typeof Notification !== 'undefined' && Notification.permission === 'default') { try { Notification.requestPermission(); } catch {} }
  } else { A.keepAlive(false); hideNote(); nUnread = 0; }
  paintBadge();
}
nSw.checked = notifOn;
nSw.addEventListener('change', () => setNotif(nSw.checked, true));
if (notifOn) setTimeout(startBg, 1800); // tunggu animasi menu selesai dulu
})();
