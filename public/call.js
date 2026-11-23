/* ===== Telepon AI (fitur rahasia) =====
   Cara membuka: kirim pesan rahasia ke Reze (kode: lihat CALL_SECRET di index.html, tryCall). Pesan itu dicegat di browser
   dan TIDAK dikirim ke server. Setelah terbuka, tombol telepon muncul di header setiap chat 1-lawan-1.

   Cara kerja (mode telepon, layar penuh):
   - Mikrofon mendengarkan terus (Web Speech API bawaan browser, sama seperti voice note di index.html).
   - User berhenti bicara selama CFG.SILENCE_MS (3 detik) -> seluruh ucapannya dikirim ke AI sebagai SATU giliran.
   - Selama AI mikir dan bicara, mikrofon DIMATIKAN dan hasil dengarnya dibuang: user tidak bisa menyela, harus menunggu giliran.
   - Selesai bicara, mikrofon menyala lagi dan giliran kembali ke user.
   - Terasa seperti telepon sungguhan: nada dering, karakter mengangkat dan menyapa duluan, avatar berdenyut mengikuti suaranya,
     nada tutup, layar tidak mati. Semua petunjuk di layar (status, teks ucapanmu, subtitle, hitung mundur) DISEMBUNYIKAN secara
     default; nyalakan di Pengaturan > Telepon kalau mau. Pengaturan itu baru muncul setelah fitur dibuka lewat kode rahasia.
   - Pakai jalur yang sama dengan chat biasa (/api/chat, /api/tts, riwayat, memori, hubungan), jadi percakapannya
     tetap tercatat di obrolan sebagai bubble teks + voice note. Tanpa voice nyala, balasan dibacakan lewat suara browser.
   - Salah ucap / salah tangkap? Selagi giliranmu dan ada teks tertangkap, muncul tiga tombol di bawah subtitle:
     Ulang (hapus teks lalu ngomong lagi), Edit (koreksi teks ucapanmu dengan mengetik; hitung mundur kirim berhenti selama mengedit),
     Kirim (kirim sekarang tanpa menunggu jeda diam). Saat mengedit: Enter = kirim, Shift+Enter = baris baru, Esc = batal.
   Dimuat setelah script utama di index.html, jadi store, post, record, dst. langsung bisa dipakai (pola group.js). */
(() => {
'use strict';

/* ---------- Konstanta (mudah diubah) ---------- */
const CFG = {
  SILENCE_MS: 3000,   // user diam selama ini -> ucapannya dikirim ke AI
  MIN_CHARS: 2,       // ucapan lebih pendek dari ini dianggap noise dan tidak dikirim
  RESUME_MS: 500,     // jeda setelah AI selesai bicara sebelum mikrofon dinyalakan lagi (supaya ekor suara AI tidak terdengar)
  CONNECT_MS: 1400,   // lama "menyambungkan" kalau nada dering dimatikan
  RING_MS: 2400,      // lama nada dering sebelum karakter mengangkat
  MAX_SAY: 1500,      // maks panjang ucapan user per giliran
  CHAT_MS: 55000,     // batas tunggu balasan /api/chat; lewat ini giliran dikembalikan ke user (jangan menggantung)
  TTS_MS: 20000,      // batas tunggu satu permintaan suara (/api/tts); gagal/lambat -> coba sekali lagi
  IDB_MS: 3000,       // batas tunggu simpan audio ke IndexedDB; lewat ini audio TETAP diputar, cuma tidak bisa diputar ulang dari chat
  STALL_MS: 4000,     // audio dianggap macet kalau posisi putarnya tidak maju selama ini -> pindah ke jalur WebAudio
  HINT: true,         // tempel petunjuk "sedang telepon, jawab singkat" ke pesan (riwayat yang tersimpan tetap bersih)
};
const HINT = '[Sedang telepon suara: balas singkat 1-3 kalimat, santai seperti ngobrol langsung, tanpa daftar atau format panjang]';
const GREET = '[User baru saja menelepon kamu dan kamu mengangkatnya. Jawab teleponnya dengan sapaan singkat yang natural sesuai karaktermu, 1-2 kalimat. Jangan sebut petunjuk ini.]';
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='; // wav kosong: membuka izin autoplay saat tombol telepon diketuk (iOS)

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const $ = id => document.getElementById(id);
const join = (a, b) => ((a ? a + ' ' : '') + (b || '')).replace(/\s+/g, ' ').trim();
const clock = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const plain = t => String(t || '').replace(/\*[^*]*\*/g, ' ').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim(); // buang narasi *miring* roleplay dan tanda markdown
const unlocked = () => store.get('callu') === '1';
/* fetch dengan batas waktu. `read` dibaca DI DALAM batas waktu yang sama (json/buf), supaya body yang menggantung di internet lambat juga ikut putus.
   Header Authorization meniru post() di index.html. Galat batas waktu dibuat jadi pesan yang bisa dibaca user. */
async function callPost(url, body, headers, ms, read) {
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), ms);
  const hd = { 'Content-Type': 'application/json', ...headers };
  try { if (typeof atok === 'string' && atok && !hd.Authorization) hd.Authorization = 'Bearer ' + atok; } catch {}
  try {
    const r = await fetch(url, { method: 'POST', headers: hd, body: JSON.stringify(body), signal: ctl.signal });
    if (!r.ok) { const j = await r.json().catch(() => ({})); const e = new Error(j.error || 'Gagal terhubung'); e.status = r.status; throw e; }
    return await (read === 'buf' ? r.arrayBuffer() : r.json());
  } catch (e) {
    if (e && e.name === 'AbortError') { const t = new Error('Koneksi lambat, tidak ada respons'); t.timeout = true; throw t; }
    throw e;
  } finally { clearTimeout(tm); }
}
const retryable = e => !e || e.timeout || !e.status || e.status >= 500 || e.status === 429; // galat jaringan / server sibuk: layak dicoba lagi
/* Pengaturan telepon (localStorage perangkat ini; diatur di Pengaturan > Telepon) */
const opt = {
  hint: () => store.get('callhint') === '1',        // default MATI: status (mendengarkan/mikir/bicara) + hitung mundur pengiriman
  sub: () => store.get('callsub') !== '0',          // default NYALA: subtitle balasan karakter (teks yang dia ucapkan)
  subMe: () => store.get('callsubme') !== '0',      // default NYALA: subtitle ucapanmu sendiri (teks yang ditangkap mic, langsung terlihat)
  ring: () => store.get('callring') !== '0',        // default nyala: nada dering + nada tutup
  greet: () => store.get('callgreet') !== '0',      // default nyala: karakter mengangkat dan menyapa duluan
  sil: () => { const v = +store.get('callsil'); return [2000, 3000, 4000, 5000].includes(v) ? v : CFG.SILENCE_MS; }
};

const CALL = window.CALL = { cfg: CFG, on: () => !!S };
let S = null; // { chId, c, state, fin, cur, last, rec, muted, ended, audio, stopAudio, ... } selama telepon berlangsung
let ui = null;
let held = false; // true = flag `busy` di index.html sedang dipegang telepon (supaya sisa `busy` dari telepon sebelumnya tidak memblokir telepon berikutnya)
const hold = () => { held = true; busy = true; refresh(); };
const release = () => { if (held) { held = false; busy = false; refresh(); } };

/* ---------- Tombol telepon di header ---------- */
function ensureBtn() {
  let b = $('callbtn'); if (b) return b;
  const hd = document.querySelector('#chatview > header'), anchor = $('find'); if (!hd) return null;
  b = document.createElement('button'); b.id = 'callbtn'; b.type = 'button'; b.className = 'hide';
  b.title = 'Telepon'; b.setAttribute('aria-label', 'Telepon karakter');
  b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1 1 .4 1.9.7 2.8a2 2 0 01-.5 2.1L8.1 9.9a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.4c.9.3 1.8.6 2.8.7a2 2 0 011.7 2z"/></svg>';
  hd.insertBefore(b, anchor || hd.querySelector('#pinbtn') || null);
  b.onclick = start;
  return b;
}
function paintBtn() {
  const b = ensureBtn(); if (!b) return;
  const ok = unlocked() && !!ch && app.classList.contains('open') && !(window.GX && GX.cur);
  b.classList.toggle('hide', !ok);
}
CALL.paint = () => { paintBtn(); paintSettings(); }; // dipanggil tryCall (index.html) setelah kode rahasia benar
new MutationObserver(() => { paintBtn(); if (S && (!app.classList.contains('open') || (window.GX && GX.cur))) end('Telepon diakhiri'); }).observe(app, { attributes: true, attributeFilter: ['class'] }); // chat ditutup saat telepon: telepon ikut berakhir
new MutationObserver(() => { paintBtn(); if (S && (!ch || ch.id !== S.chId)) end('Telepon diakhiri karena pindah chat'); }).observe($('hname'), { childList: true, characterData: true, subtree: true });
paintBtn();

/* ---------- Pengaturan > Telepon (grup disisipkan lewat JS, tampil hanya kalau fitur sudah dibuka) ---------- */
let sgrp = null;
function buildSettings() {
  if (sgrp) return sgrp;
  const after = $('smediag'); if (!after || !after.parentNode) return null;
  const g = document.createElement('div'); g.className = 'sgroup hide'; g.id = 'scallg';
  const sw = (id, t, d) => '<label class="srow"><span><b>' + t + '</b><i>' + d + '</i></span><input type="checkbox" id="' + id + '" class="sw"></label>';
  g.innerHTML = '<h3>Telepon</h3>' +
    sw('scallsub', 'Subtitle karakter', 'Teks yang diucapkan karakter tampil di layar telepon selagi dia bicara. Default nyala.') +
    sw('scallsubme', 'Subtitle kamu', 'Teks ucapanmu yang ditangkap mic tampil langsung di layar, jadi kamu bisa cek apakah suaramu terdengar benar. Default nyala.') +
    sw('scallhint', 'Petunjuk lainnya', 'Status (mendengarkan, mikir, bicara) dan hitung mundur pengiriman. Terpisah dari subtitle. Kalau subtitle dan petunjuk ini mati semua, layar telepon bersih seperti telepon biasa. Default mati.') +
    sw('scallring', 'Nada dering & efek suara', 'Telepon berdering sebelum diangkat, dan ada nada saat ditutup. Default nyala.') +
    sw('scallgreet', 'Karakter menyapa duluan', 'Setelah berdering, karakter mengangkat dan menyapa lebih dulu. Kalau mati, kamu yang bicara pertama. Default nyala.') +
    '<div class="srow" style="display:block;cursor:default"><span><b>Jeda diam sebelum terkirim</b><i>Setelah kamu berhenti bicara selama ini, ucapanmu dikirim ke karakter.</i></span><div class="seg x4" id="scallsil"><button type="button" data-v="2000">2 dtk</button><button type="button" data-v="3000">3 dtk</button><button type="button" data-v="4000">4 dtk</button><button type="button" data-v="5000">5 dtk</button></div></div>';
  after.parentNode.insertBefore(g, after.nextSibling);
  $('scallhint').onchange = () => store.set('callhint', $('scallhint').checked ? '1' : null);
  $('scallsub').onchange = () => store.set('callsub', $('scallsub').checked ? null : '0');
  $('scallsubme').onchange = () => store.set('callsubme', $('scallsubme').checked ? null : '0');
  $('scallring').onchange = () => store.set('callring', $('scallring').checked ? null : '0');
  $('scallgreet').onchange = () => store.set('callgreet', $('scallgreet').checked ? null : '0');
  $('scallsil').onclick = e => { const b = e.target.closest('button'); if (!b) return; store.set('callsil', b.dataset.v === String(CFG.SILENCE_MS) ? null : b.dataset.v); paintSettings(); };
  return (sgrp = g);
}
function paintSettings() {
  const g = buildSettings(); if (!g) return;
  g.classList.toggle('hide', !unlocked());
  $('scallhint').checked = opt.hint(); $('scallsub').checked = opt.sub(); $('scallsubme').checked = opt.subMe(); $('scallring').checked = opt.ring(); $('scallgreet').checked = opt.greet();
  $('scallsil').querySelectorAll('button').forEach(b => b.classList.toggle('sel', +b.dataset.v === opt.sil()));
}
CALL.paintSettings = paintSettings;
{ const sb = $('setbtn'); if (sb) sb.addEventListener('click', paintSettings); }
paintSettings();

/* ---------- Efek suara (WebAudio): nada dering, nada angkat, nada tutup ---------- */
function tone(ac, t0, freqs, dur, vol) {
  const g = ac.createGain(); g.connect(ac.destination);
  g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + 0.03); g.gain.setValueAtTime(vol, t0 + dur - 0.05); g.gain.linearRampToValueAtTime(0, t0 + dur);
  freqs.forEach(f => { const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.connect(g); o.start(t0); o.stop(t0 + dur + 0.02); });
}
function sfx(s, kind) {
  if (!opt.ring()) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ac = s.ac || (s.ac = new AC()); if (ac.state === 'suspended') ac.resume();
    const t = ac.currentTime + 0.02;
    if (kind === 'ring') { tone(ac, t, [425, 450], 0.9, 0.06); tone(ac, t + 1.4, [425, 450], 0.9, 0.06); } // dua dering
    else if (kind === 'pick') tone(ac, t, [880], 0.07, 0.05);
    else if (kind === 'end') { tone(ac, t, [480, 620], 0.16, 0.06); tone(ac, t + 0.24, [480, 620], 0.16, 0.06); }
  } catch {}
}
const buzz = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch {} };

/* ---------- Layar telepon ---------- */
function build() {
  if (ui) return ui;
  const el = document.createElement('div'); el.id = 'callui'; el.className = 'hide'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Telepon');
  el.innerHTML =
    '<div class="cl-top"><b class="cl-name"></b><span class="cl-time">0:00</span></div>' +
    '<div class="cl-stage"><div class="cl-ring"><i></i><i></i><i></i></div><div class="cl-avwrap"></div><div class="cl-dots" aria-hidden="true"><i></i><i></i><i></i></div></div>' +
    '<div class="cl-status" aria-live="polite"></div>' +
    '<div class="cl-cap"></div>' +
    '<div class="cl-you"></div>' +
    '<textarea class="cl-edit" rows="3" maxlength="1500" placeholder="Ketik koreksi ucapanmu…" aria-label="Edit teks ucapanmu"></textarea>' +
    '<div class="cl-act"><button type="button" class="cl-redo">Ulang</button><button type="button" class="cl-fix">Edit</button><button type="button" class="cl-cancel">Batal</button><button type="button" class="cl-sendnow">Kirim</button></div>' +
    '<div class="cl-bar"><i></i></div>' +
    '<div class="cl-note"></div>' +
    '<div class="cl-btns">' +
      '<button type="button" class="cl-mute" aria-label="Matikan mikrofon" aria-pressed="false"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/><path class="cl-slash" d="M4 4l16 16"/></svg></button>' +
      '<button type="button" class="cl-end" aria-label="Akhiri telepon"><svg viewBox="0 0 24 24"><path d="M3 14.5c5-4.7 13-4.7 18 0l-2.4 2.6-3-1.3v-2.6c-2-.6-3.2-.6-5.2 0v2.6l-3 1.3z"/></svg></button>' +
    '</div>';
  app.append(el);
  ui = { el, name: el.querySelector('.cl-name'), time: el.querySelector('.cl-time'), av: el.querySelector('.cl-avwrap'), status: el.querySelector('.cl-status'),
    cap: el.querySelector('.cl-cap'), you: el.querySelector('.cl-you'), bar: el.querySelector('.cl-bar i'), note: el.querySelector('.cl-note'),
    mute: el.querySelector('.cl-mute'), end: el.querySelector('.cl-end'), noteT: 0,
    edit: el.querySelector('.cl-edit'), redo: el.querySelector('.cl-redo'), fix: el.querySelector('.cl-fix'), cancel: el.querySelector('.cl-cancel'), sendnow: el.querySelector('.cl-sendnow') };
  ui.end.onclick = () => end();
  ui.mute.onclick = toggleMute;
  ui.redo.onclick = redo; ui.fix.onclick = startEdit; ui.cancel.onclick = cancelEdit;
  ui.sendnow.onclick = () => (S && S.editing ? sendEdit() : sendNow());
  ui.edit.onkeydown = e => { // tombol keyboard di kolom edit tidak boleh bocor ke pintasan aplikasi
    e.stopPropagation(); if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendEdit(); } else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  };
  ui.edit.onkeyup = ui.edit.onkeypress = e => e.stopPropagation();
  return ui;
}
function note(t) { if (!ui) return; ui.note.textContent = t; ui.note.classList.add('show'); clearTimeout(ui.noteT); ui.noteT = setTimeout(() => ui.note.classList.remove('show'), 3200); }
function paint() {
  if (!S || !ui) return;
  const n = S.c ? (typeof dispName === 'function' ? dispName(S.c) : S.c.name) : '';
  const txt = {
    connecting: 'Berdering…',
    listening: S.editing ? 'Mengedit ucapanmu' : S.muted ? 'Mikrofon dimatikan' : (full() ? 'Mendengarkan…' : 'Giliranmu, ngomong aja'),
    thinking: n + ' lagi mikir…',
    speaking: n + ' lagi bicara. Tunggu giliranmu'
  }[S.state] || '';
  ui.status.textContent = txt;
  ui.el.dataset.state = S.state; ui.el.classList.toggle('muted', S.muted); ui.el.classList.toggle('nohint', !S.hint); ui.el.classList.toggle('nosub', !S.sub); ui.el.classList.toggle('nosubme', !S.subMe);
  ui.mute.setAttribute('aria-pressed', S.muted ? 'true' : 'false'); ui.mute.disabled = S.state !== 'listening' || !!S.editing;
  paintYou();
}
function paintYou() {
  if (!ui || !S) return;
  const t = S.state === 'listening' ? full() : '';
  ui.you.textContent = t.length > 160 ? '…' + t.slice(-158) : t;
  ui.el.classList.toggle('editing', !!S.editing && S.state === 'listening');
  ui.el.classList.toggle('hastxt', !S.editing && t.length >= CFG.MIN_CHARS); // tombol Ulang / Edit / Kirim hanya muncul kalau ada teks tertangkap
}
const full = () => S ? join(S.fin, join(S.cur.f, S.cur.i)) : '';

/* ---------- Mulai / akhiri ---------- */
async function start() {
  if (S) { if (S.ended) S = null; else return; }
  if (!unlocked() || !ch || !app.classList.contains('open') || (window.GX && GX.cur)) return;
  if (!SR) { toast('Browser ini belum mendukung suara ke teks. Pakai Chrome, Edge, atau Safari terbaru.'); return; }
  if (!window.isSecureContext) { toast('Telepon butuh koneksi aman (https)'); return; }
  const el = new Audio(); el.src = SILENT; const pr = el.play(); if (pr && pr.catch) pr.catch(() => {}); // harus sinkron di dalam ketukan user
  const ac0 = (() => { try { const AC = window.AudioContext || window.webkitAudioContext; const a = AC && new AC(); if (a && a.state === 'suspended') a.resume(); return a || null; } catch { return null; } })(); // dibuat saat ketukan supaya nada dering boleh bunyi
  if (current) current.stop();
  if (pend.length) await pendFlush(false); // pesan yang masih mengantre dikirim dulu
  if (busy && !held) { toast(ch.name + ' masih membalas, tunggu sebentar'); return; }
  if (S) return; // ketukan ganda saat menunggu antrean
  const c = ch;
  S = { chId: c.id, c, state: 'connecting', fin: '', cur: { f: '', i: '' }, last: 0, rec: null, muted: false, ended: false, el, ac: ac0, hint: opt.hint(), sub: opt.sub(), subMe: opt.subMe(), turns: 0, fast: 0, gen: 0, t0: Date.now(), stopAudio: null, stopTts: null, tick: 0 };
  const u = build();
  u.name.textContent = typeof dispName === 'function' ? dispName(c) : c.name;
  u.av.textContent = ''; u.av.append(img(c, 'cl-av'));
  u.cap.textContent = ''; u.you.textContent = ''; u.edit.value = ''; u.el.classList.remove('hastxt', 'editing'); u.time.textContent = '0:00'; u.bar.style.width = '0%'; u.note.classList.remove('show');
  clearTimeout(u.hideT); u.el.classList.remove('hide'); void u.el.offsetWidth; u.el.classList.add('on');
  hold(); // chat di belakang layar tidak bisa dikirimi apa pun selama telepon
  paint();
  S.tick = setInterval(onTick, 100);
  const me = S, ringing = opt.ring(), ringMs = (ringing ? CFG.RING_MS : CFG.CONNECT_MS) + 150; // +150: beri Chrome waktu melepas mikrofon dari telepon sebelumnya
  buzz(25); if (ringing) sfx(me, 'ring');
  try { navigator.wakeLock && navigator.wakeLock.request('screen').then(w => { if (S === me) me.wl = w; else w.release(); }).catch(() => {}); } catch {} // layar tidak mati selama telepon
  me.ringP = sleep(ringMs).then(() => { if (S !== me || me.ended) return; me.t0 = Date.now(); if (ringing) sfx(me, 'pick'); buzz(15); }); // diangkat: hitung durasi mulai dari sini
  if (opt.greet()) { // permintaan sapaan langsung dikirim, jadi latensinya tertutup oleh nada dering
    turn('', true);
  } else {
    me.ringP.then(() => { if (S === me && !me.ended) { me.state = 'listening'; me.last = 0; paint(); listen(); } });
  }
}

function end(why) {
  if (!S) return;
  const s = S; s.ended = true; clearInterval(s.tick);
  const inflight = s.state === 'thinking'; // permintaan ke AI masih jalan: busy dilepas oleh turn() setelah balasannya dicatat
  S = null; // dikosongkan DULU: apa pun yang gagal di bawah tidak boleh membuat telepon berikutnya macet
  try { s.rec && s.rec.abort(); } catch {}
  s.rec = null;
  try { s.stopAudio && s.stopAudio(); } catch {}
  try { s.stopTts && s.stopTts(); } catch {}
  try { s.el.pause(); s.el.removeAttribute('src'); } catch {}
  try { window.speechSynthesis && speechSynthesis.cancel(); } catch {}
  try { s.wl && s.wl.release(); } catch {}
  if (s.state !== 'connecting') { sfx(s, 'end'); buzz(40); } // nada tutup (tidak bunyi kalau dibatalkan saat masih berdering)
  setTimeout(() => { try { s.ac && s.ac.close(); } catch {} }, 900);
  if (ui) { ui.el.classList.remove('on'); clearTimeout(ui.hideT); ui.hideT = setTimeout(() => { if (!S) ui.el.classList.add('hide'); }, 220); }
  if (!inflight) release();
  if (why) toast(why); else toast('Telepon berakhir · ' + clock((Date.now() - s.t0) / 1000));
}

function toggleMute() {
  if (!S || S.state !== 'listening' || S.editing) return;
  S.muted = !S.muted;
  if (S.muted) { try { S.rec && S.rec.abort(); } catch {} S.rec = null; }
  else { S.last = full() ? Date.now() : 0; listen(); }
  paint();
}

/* ---------- Koreksi ucapan: Ulang / Edit / Kirim ---------- */
function stopRec(s) { const r = s.rec; s.rec = null; try { r && r.abort(); } catch {} } // s.rec dikosongkan DULU supaya onend/onresult sesi lama diabaikan
function redo() { // hapus teks yang tertangkap lalu dengarkan dari awal
  if (!S || S.state !== 'listening' || S.editing) return;
  const s = S; stopRec(s); s.fin = ''; s.cur = { f: '', i: '' }; s.last = 0;
  paint(); if (!s.muted) { listen(); note('Dihapus, silakan ngomong lagi'); }
}
function sendNow() { // kirim sekarang tanpa menunggu jeda diam
  if (!S || S.state !== 'listening' || S.editing) return;
  const t = full(); if (t.length < CFG.MIN_CHARS) return;
  turn(t);
}
function startEdit() { // teks ucapan jadi bisa diketik; mikrofon dan hitung mundur kirim berhenti sampai Kirim / Batal
  if (!S || S.state !== 'listening' || S.editing || !ui) return;
  const s = S, t = full(); stopRec(s);
  s.editing = true; s.editOrig = t; s.fin = t; s.cur = { f: '', i: '' }; s.last = 0;
  ui.edit.value = t; paint();
  try { ui.edit.focus(); ui.edit.setSelectionRange(t.length, t.length); } catch {}
}
function sendEdit() {
  if (!S || !S.editing || !ui) return;
  const s = S, t = ui.edit.value.replace(/\s+/g, ' ').trim().slice(0, CFG.MAX_SAY);
  if (t.length < CFG.MIN_CHARS) { note('Teksnya kosong. Tulis dulu, atau tekan Batal'); return; }
  s.editing = false; try { ui.edit.blur(); } catch {}
  turn(t);
}
function cancelEdit() { // batal: balik ke teks tangkapan mic sebelum diedit, lalu lanjut mendengarkan
  if (!S || !S.editing || !ui) return;
  const s = S; s.editing = false; try { ui.edit.blur(); } catch {}
  s.fin = s.editOrig || ''; s.cur = { f: '', i: '' }; s.last = s.fin ? Date.now() : 0;
  paint(); if (!s.muted) listen();
}

/* ---------- Mendengarkan ---------- */
function listen() {
  if (!S || S.ended || S.muted || S.rec || S.editing || S.state !== 'listening') return;
  const s = S, r = new SR(), born = Date.now();
  s.rec = r; s.cur = { f: '', i: '' };
  r.lang = store.get('sttlang') || 'id-ID'; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
  r.onresult = e => {
    if (S !== s || s.rec !== r || s.state !== 'listening') return; // bukan giliran user: hasil dengar dibuang
    let f = '', i = '';
    for (let k = 0; k < e.results.length; k++) { const x = e.results[k]; if (x.isFinal) f += ' ' + x[0].transcript; else i += ' ' + x[0].transcript; }
    s.cur = { f: f.trim(), i: i.trim() };
    if (s.cur.f || s.cur.i) s.last = Date.now(); // tiap ada suara baru, hitung mundur 3 detik mulai dari nol
    paintYou(); if (ui) ui.status.textContent = 'Mendengarkan…';
  };
  r.onerror = e => {
    if (S !== s) return;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { end('Izin mikrofon ditolak. Aktifkan di pengaturan browser.'); return; }
    if (e.error === 'audio-capture') { end('Mikrofon tidak bisa dipakai'); return; }
    if (e.error === 'language-not-supported') { end('Bahasa suara tidak didukung browser ini'); return; }
    if (e.error === 'network') { note('Pengenalan suara butuh internet'); }
    else if (e.error === 'aborted') { s.fast++; } // Chrome menolak start yang terlalu cepat setelah abort: onend akan mencoba lagi dengan jeda
  };
  r.onend = () => {
    if (S !== s || s.rec !== r) return;
    s.fin = join(s.fin, join(s.cur.f, s.cur.i)); s.cur = { f: '', i: '' }; s.rec = null; // browser menutup sesi sendiri saat hening: teks disimpan, sesi baru dibuka
    s.fast = Date.now() - born < 350 ? s.fast + 1 : 0;
    if (s.state === 'listening' && !s.muted && !s.ended) setTimeout(listen, s.fast >= 3 ? 1200 : 120);
  };
  try { r.start(); } catch (e) { s.rec = null; s.fails = (s.fails || 0) + 1; if (s.fails === 3) note('Mikrofon belum siap, mencoba lagi…'); setTimeout(listen, 500); }
}

/* Gestur karakter di layar (tidak bergantung pada pengaturan petunjuk): data-g di #callui, gerakannya ada di call.css.
   listening = bernapas pelan, hear = condong/miring menyimak, wait = mengangguk pelan, thinking = miring + tiga titik. */
function gest(g) { if (ui && ui.el.dataset.g !== g) ui.el.dataset.g = g; }
function onTick() {
  if (!S) return;
  const s = S;
  if (s.state === 'connecting') { ui.time.textContent = '0:00'; gest(''); return; }
  ui.time.textContent = clock((Date.now() - s.t0) / 1000);
  if (s.state === 'listening') s.busySince = 0; else if (!s.busySince) s.busySince = Date.now();
  if (s.busySince && Date.now() - s.busySince > 120000) { s.busySince = 0; s.gen++; s.state = 'listening'; s.last = 0; try { s.stopAudio && s.stopAudio(); s.stopTts && s.stopTts(); } catch {} note('Respons terlalu lama, giliranmu lagi'); paint(); listen(); return; } // jaring pengaman
  if (s.state !== 'listening' || s.muted || s.editing) { ui.bar.style.width = '0%'; gest(''); return; } // mengedit: hitung mundur kirim berhenti
  const txt = full();
  if (txt.length < CFG.MIN_CHARS || !s.last) { ui.bar.style.width = '0%'; gest(''); return; }
  const idle = Date.now() - s.last;
  gest(idle < 700 ? 'hear' : 'wait'); // gestur karakter (tanpa teks): 'hear' = menyimak kamu bicara, 'wait' = diam sebentar, menunggu kamu lanjut
  const sil = opt.sil();
  if (s.hint) {
    ui.bar.style.width = Math.min(100, idle / sil * 100) + '%';
    if (idle > 700) ui.status.textContent = 'Kamu diam… mengirim dalam ' + Math.max(1, Math.ceil((sil - idle) / 1000)) + ' dtk';
  }
  if (idle >= sil) turn(txt);
}

/* ---------- Satu giliran: kirim ke AI, lalu AI bicara ---------- */
async function turn(raw, greet) {
  const s = S; if (!s || (!greet && s.state !== 'listening')) return;
  const gen = s.gen; // giliran ini "basi" kalau jaring pengaman sudah menaikkan gen: tidak boleh menyentuh state telepon lagi
  try { await turn1(s, raw, !!greet, gen); }
  catch (e) { // apa pun yang meledak: kembalikan giliran ke user, jangan biarkan telepon menggantung
    console.warn('[call]', e);
    if (S === s && s.gen === gen) { note('Ada kendala: ' + (e && e.message || e)); s.state = 'listening'; s.last = 0; paint(); listen(); } else if (!S) release();
  }
}
async function turn1(s, raw, greet, gen) {
  const alive = () => S === s && !s.ended && s.gen === gen; // greet: karakter mengangkat telepon dan menyapa duluan (tanpa pesan user)
  const chId = s.chId, text = raw.trim().charAt(0).toUpperCase() + raw.trim().slice(1);
  const say = text.slice(0, CFG.MAX_SAY);
  if (!greet) s.state = 'thinking'; s.turns++; // sapaan: status tetap "berdering" sampai diangkat
  try { s.rec && s.rec.abort(); } catch {} s.rec = null; // mikrofon mati: user tidak bisa membalas sampai AI selesai
  s.fin = ''; s.cur = { f: '', i: '' }; s.last = 0;
  ui.bar.style.width = '0%'; ui.cap.textContent = ''; ui.cap.classList.remove('talk');
  paint();
  if (!greet) { if (stillHere(chId)) addText(say); record(chId, { r: 'me', x: say }); }
  const useVoice = voiceOn && !!vcode && canVoice(chId), lang = voiceLang;
  let r = null, relNote = '';
  try {
    r = await callPost('/api/chat', {
      clientId: cid, char: chId, message: greet ? GREET : (CFG.HINT ? HINT + '\n' : '') + say, userName: uname, history: loadHist(chId),
      voice: { on: useVoice, lang }, memory: memUse(chId).list, rel: relPayload(chId), qr: true, ...engPayload(), ...(rpOn() ? { rp: true } : {})
    }, null, CFG.CHAT_MS, 'json');
    saveHist(chId, [...loadHist(chId), ['user', greet ? '(menelepon dan telepon diangkat)' : say], ['char', r.id]]); // riwayat memakai teks asli user, tanpa petunjuk telepon
    relNote = relApply(chId, r.dExp != null ? r.dExp : (Math.round(Number(r.dRel)) || 0) * 3, r.dMood);
  } catch (e) {
    r = null;
    if (alive()) note(e.message || 'Gagal terhubung'); else toast(e.message || 'Gagal terhubung');
  }
  if (r) {
    if (alive()) {
      if (greet && s.ringP) await s.ringP; // karakter baru "mengangkat" setelah nada dering selesai
      if (!alive()) { showThemSafe(chId, r.id); } else {
        s.state = 'thinking'; paint(); // tetap "mikir" (tiga titik) selama suara disiapkan; baru jadi "bicara" saat audio benar-benar mulai
        try { await speak(s, chId, r, useVoice, lang, alive); } catch (e) { note(e.message || 'Suara gagal'); }
      }
    } else {
      showThemSafe(chId, r.id); // telepon sudah ditutup saat menunggu: balasan tetap masuk obrolan sebagai teks
    }
    if (typeof maybeMemorize === 'function') maybeMemorize(chId);
    if (Array.isArray(r.nq)) r.nq.forEach((tt, i) => setTimeout(() => (S ? note(tt) : toast(tt)), 600 + i * 2300));
    if (relNote) { if (alive()) note(relNote); else toast(relNote); }
  }
  if (greet && s.ringP) await s.ringP; // sapaan gagal: tetap tunggu dering selesai sebelum giliran user
  if (!alive()) { if (!S) release(); return; } // telepon sudah diakhiri (kalau sudah ada telepon baru, busy miliknya, jangan dilepas) / giliran ini basi
  s.state = 'speaking'; paint();
  await new Promise(res => setTimeout(res, CFG.RESUME_MS));
  if (!alive()) return;
  s.state = 'listening'; s.last = 0; ui.cap.classList.remove('talk'); paint(); listen(); // giliran kembali ke user
}

/* ---------- AI bicara ---------- */
const sleep = ms => new Promise(res => setTimeout(res, ms));
function pulse(a, bins) { // avatar berdenyut mengikuti kenyaringan suara karakter (dari waveform hasil decode)
  if (!ui || !bins || !bins.length || typeof requestAnimationFrame !== 'function') return () => {};
  const mx = Math.max(...bins) || 1; let raf = 0, on = true;
  const f = () => { if (!on) return; const d = a.duration || 0, i = d ? Math.min(bins.length - 1, Math.floor(a.currentTime / d * bins.length)) : 0; ui.av.style.setProperty('--lv', Math.min(1, bins[i] / mx).toFixed(2)); raf = requestAnimationFrame(f); };
  raf = requestAnimationFrame(f);
  return () => { on = false; cancelAnimationFrame(raf); ui.av.style.setProperty('--lv', 0); };
}
/* Memutar satu potong suara. Mengembalikan true kalau terputar (atau dihentikan sengaja), false kalau benar-benar gagal bunyi.
   Jalur utama: elemen <audio> yang sudah "dibuka" saat ketukan tombol telepon. Pengaman supaya tidak diam selamanya:
   - play() ditolak / elemen error / posisi putar tidak maju STALL_MS -> pindah ke WebAudio (AudioContext yang juga dibuka saat ketukan)
   - batas waktu keras (durasi + 6 dtk): kalau onended tidak pernah datang, giliran tetap lanjut */
function playUrl(s, pre, ab) {
  return new Promise(res => {
    const a = s.el; let done = false, wd = 0, src = null, wa = false;
    const stopP = pulse(a, pre.bins);
    const fin = ok => { if (done) return; done = true; clearInterval(wd); stopP(); s.stopAudio = null; a.onended = a.onerror = null; try { src && src.stop(); } catch {} res(ok); };
    s.stopAudio = () => { try { a.pause(); } catch {} fin(true); };
    const fallback = () => {
      if (done || wa) return; wa = true;
      try { a.pause(); } catch {}
      const ac = s.ac; if (!ac || !ab) return fin(false);
      try { if (ac.state === 'suspended') ac.resume(); } catch {}
      ac.decodeAudioData(ab.slice(0)).then(buf => {
        if (done) return;
        src = ac.createBufferSource(); src.buffer = buf; src.connect(ac.destination); src.onended = () => fin(true); src.start();
      }).catch(() => fin(false));
    };
    a.onended = () => fin(true); a.onerror = fallback;
    const t0 = Date.now(), maxMs = (pre.dur || 60) * 1000 + 6000; let lastT = -1, stuck = 0;
    wd = setInterval(() => {
      if (done) return;
      if (Date.now() - t0 > maxMs) return fin(true);
      if (wa) return;
      if (a.ended) return fin(true);
      if (a.currentTime > lastT + 0.01) { lastT = a.currentTime; stuck = 0; }
      else if (++stuck * 500 >= CFG.STALL_MS) { if (lastT < 0.3) fallback(); else fin(true); } // belum pernah jalan -> coba WebAudio; macet di tengah -> lanjut saja
    }, 500);
    a.src = pre.url; const p = a.play(); if (p && p.catch) p.catch(fallback);
  });
}
async function ttsBuf(chId, p) { // satu potong suara dari server; galat jaringan/server dicoba sekali lagi
  let err;
  for (let k = 0; k < 2; k++) {
    try { return await callPost('/api/tts', { char: chId, text: p.vn, voice: voiceKeyOf(chId) }, { 'x-voice-code': vcode }, CFG.TTS_MS, 'buf'); }
    catch (e) { err = e; if (!retryable(e)) break; }
  }
  throw err;
}
function speakSynth(s, text) { // tanpa voice AI: dibacakan suara bawaan browser
  return new Promise(res => {
    const synth = window.speechSynthesis; let done = false;
    const fin = () => { if (done) return; done = true; s.stopTts = null; clearTimeout(guard); if (ui) ui.el.classList.remove('fb'); res(); };
    const guard = setTimeout(fin, Math.max(2500, text.length * 110 + 2500)); // onend tidak selalu datang di semua browser
    if (!synth || !text) { setTimeout(fin, Math.max(1500, text.length * 55)); s.stopTts = fin; return; } // tanpa suara browser: beri waktu baca
    if (ui) ui.el.classList.add('fb');
    const u = new SpeechSynthesisUtterance(text); u.lang = store.get('sttlang') || 'id-ID'; u.onend = fin; u.onerror = fin;
    s.stopTts = () => { try { synth.cancel(); } catch {} fin(); };
    try { synth.cancel(); synth.speak(u); } catch { fin(); }
  });
}
async function speak(s, chId, r, useVoice, lang, alive) {
  const cap = t => { if (S === s) { ui.cap.textContent = plain(t); ui.cap.classList.add('talk'); } };
  const talk = () => { if (alive()) { s.state = 'speaking'; s.busySince = Date.now(); paint(); } }; // status jadi "bicara" hanya saat suara benar-benar mulai
  if (!useVoice) {
    talk(); showThemSafe(chId, r.id); cap(r.id);
    await speakSynth(s, plain(r.id));
    return;
  }
  const parts = (r.parts && r.parts.length > 1) ? r.parts : [{ id: r.id, jp: r.jpText, vn: r.vn }];
  let i = 0, next = ttsBuf(chId, parts[0]); next.catch(() => {});
  try {
    for (; i < parts.length; i++) {
      if (!alive()) break;
      const p = parts[i];
      const ab = await next;
      next = i + 1 < parts.length ? ttsBuf(chId, parts[i + 1]) : null; if (next) next.catch(() => {}); // potong berikutnya dibuat SELAGI potong ini diputar: tidak ada jeda diam di antaranya
      const pre = await decode(ab); urls.push(pre.url);
      const tNow = Date.now(), k = newKey(), here = stillHere(chId);
      if (here) addVN({ id: p.id, jp: p.jp, lang, vn: p.vn }, [pre], tNow); // voice note yang sama seperti chat biasa, bisa diputar ulang nanti
      // menyimpan audio (IndexedDB) jalan BERSAMAAN dengan pemutaran dan punya batas waktu: dulu diputar baru setelah tersimpan, jadi kalau IndexedDB macet voice note sudah muncul di chat tapi tidak pernah bunyi
      const persist = (async () => {
        const put = idb.put(k, { ab, dur: pre.dur, bins: pre.bins });
        const saved = await Promise.race([put, sleep(CFG.IDB_MS).then(() => 'timeout')]);
        if (saved === 'timeout') put.then(() => idb.del(k)).catch(() => {}); // telat selesai: buang supaya tidak jadi sampah, voice note tetap tercatat tanpa audio tersimpan
        else if (saved) pre.k = k;
        record(chId, { t: tNow, r: 'vn', x: p.id, jp: p.jp, lang, vn: p.vn, ...(saved && saved !== 'timeout' ? { ks: [k], si: 0 } : {}) });
      })().catch(e => console.warn('[call] simpan voice note', e));
      let ok = true;
      if (alive()) { cap(p.id); talk(); ok = await playUrl(s, pre, ab); }
      await persist;
      if (!ok && alive()) { note('Suara tidak bisa diputar, voice note ada di chat'); await sleep(Math.min(6000, 1200 + plain(p.id).length * 55)); } // teks tetap terlihat cukup lama untuk dibaca
      if (alive() && i < parts.length - 1) await sleep(250);
    }
    i = parts.length;
  } catch (e) {
    if (e.status === 403) { vcode = ''; voiceOn = false; store.set('vcode', null); store.set('von', '0'); paintVoice(); note('Kode voice tidak valid, voice dimatikan'); }
    else note(e.timeout ? 'Internet lambat, suara tidak sampai. Dibacakan suara browser' : (e.message || 'Suara gagal dibuat'));
    for (let j = i; j < parts.length; j++) { showThemSafe(chId, parts[j].id); if (j === i) cap(parts[j].id); } // suara gagal: teksnya tetap tampil dan masuk obrolan
    if (alive()) { talk(); await speakSynth(s, plain(parts[i] && parts[i].id)); }
    return;
  }
  for (let j = i; j < parts.length; j++) showThemSafe(chId, parts[j].id); // telepon ditutup di tengah: sisa balasan masuk obrolan sebagai teks
}

window.addEventListener('pagehide', () => { if (S) end('Telepon berakhir'); });
document.addEventListener('visibilitychange', () => { if (document.hidden && S && S.state === 'listening') { try { S.rec && S.rec.abort(); } catch {} } }); // tab disembunyikan: sesi dengar dibuka lagi lewat onend/listen saat kembali
document.addEventListener('visibilitychange', () => { if (!document.hidden && S && S.state === 'listening' && !S.rec && !S.muted) listen(); });
})();
