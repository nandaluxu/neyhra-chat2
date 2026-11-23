/* ===== Telepon AI (fitur rahasia) =====
   Cara membuka: kirim pesan rahasia ke Reze (kode: lihat CALL_SECRET di index.html, tryCall). Pesan itu dicegat di browser
   dan TIDAK dikirim ke server. Setelah terbuka, tombol telepon muncul di header setiap chat 1-lawan-1.

   Cara kerja (mode telepon, layar penuh):
   - Mikrofon mendengarkan terus (Web Speech API bawaan browser, sama seperti voice note di index.html).
   - User berhenti bicara selama CFG.SILENCE_MS (3 detik) -> seluruh ucapannya dikirim ke AI sebagai SATU giliran.
   - Selama AI mikir dan bicara, mikrofon DIMATIKAN dan hasil dengarnya dibuang: user tidak bisa menyela, harus menunggu giliran.
   - Selesai bicara, mikrofon menyala lagi dan giliran kembali ke user.
   - Pakai jalur yang sama dengan chat biasa (/api/chat, /api/tts, riwayat, memori, hubungan), jadi percakapannya
     tetap tercatat di obrolan sebagai bubble teks + voice note. Tanpa voice nyala, balasan dibacakan lewat suara browser.
   Dimuat setelah script utama di index.html, jadi store, post, record, dst. langsung bisa dipakai (pola group.js). */
(() => {
'use strict';

/* ---------- Konstanta (mudah diubah) ---------- */
const CFG = {
  SILENCE_MS: 3000,   // user diam selama ini -> ucapannya dikirim ke AI
  MIN_CHARS: 2,       // ucapan lebih pendek dari ini dianggap noise dan tidak dikirim
  RESUME_MS: 500,     // jeda setelah AI selesai bicara sebelum mikrofon dinyalakan lagi (supaya ekor suara AI tidak terdengar)
  CONNECT_MS: 1400,   // lama animasi "menyambungkan"
  MAX_SAY: 1500,      // maks panjang ucapan user per giliran
  HINT: true          // tempel petunjuk "sedang telepon, jawab singkat" ke pesan (riwayat yang tersimpan tetap bersih)
};
const HINT = '[Sedang telepon suara: balas singkat 1-3 kalimat, santai seperti ngobrol langsung, tanpa daftar atau format panjang]';
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA='; // wav kosong: membuka izin autoplay saat tombol telepon diketuk (iOS)

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const $ = id => document.getElementById(id);
const join = (a, b) => ((a ? a + ' ' : '') + (b || '')).replace(/\s+/g, ' ').trim();
const clock = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const plain = t => String(t || '').replace(/\*[^*]*\*/g, ' ').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim(); // buang narasi *miring* roleplay dan tanda markdown
const unlocked = () => store.get('callu') === '1';

const CALL = window.CALL = { cfg: CFG, on: () => !!S };
let S = null; // { chId, c, state, fin, cur, last, rec, muted, ended, audio, stopAudio, ... } selama telepon berlangsung
let ui = null;

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
CALL.paint = paintBtn;
new MutationObserver(() => { paintBtn(); if (S && (!app.classList.contains('open') || (window.GX && GX.cur))) end('Telepon diakhiri'); }).observe(app, { attributes: true, attributeFilter: ['class'] }); // chat ditutup saat telepon: telepon ikut berakhir
new MutationObserver(() => { paintBtn(); if (S && (!ch || ch.id !== S.chId)) end('Telepon diakhiri karena pindah chat'); }).observe($('hname'), { childList: true, characterData: true, subtree: true });
paintBtn();

/* ---------- Layar telepon ---------- */
function build() {
  if (ui) return ui;
  const el = document.createElement('div'); el.id = 'callui'; el.className = 'hide'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Telepon');
  el.innerHTML =
    '<div class="cl-top"><b class="cl-name"></b><span class="cl-time">0:00</span></div>' +
    '<div class="cl-stage"><div class="cl-ring"><i></i><i></i><i></i></div><div class="cl-avwrap"></div></div>' +
    '<div class="cl-status" aria-live="polite"></div>' +
    '<div class="cl-cap"></div>' +
    '<div class="cl-you"></div>' +
    '<div class="cl-bar"><i></i></div>' +
    '<div class="cl-note"></div>' +
    '<div class="cl-btns">' +
      '<button type="button" class="cl-mute" aria-label="Matikan mikrofon" aria-pressed="false"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/><path class="cl-slash" d="M4 4l16 16"/></svg></button>' +
      '<button type="button" class="cl-end" aria-label="Akhiri telepon"><svg viewBox="0 0 24 24"><path d="M3 14.5c5-4.7 13-4.7 18 0l-2.4 2.6-3-1.3v-2.6c-2-.6-3.2-.6-5.2 0v2.6l-3 1.3z"/></svg></button>' +
    '</div>';
  app.append(el);
  ui = { el, name: el.querySelector('.cl-name'), time: el.querySelector('.cl-time'), av: el.querySelector('.cl-avwrap'), status: el.querySelector('.cl-status'),
    cap: el.querySelector('.cl-cap'), you: el.querySelector('.cl-you'), bar: el.querySelector('.cl-bar i'), note: el.querySelector('.cl-note'),
    mute: el.querySelector('.cl-mute'), end: el.querySelector('.cl-end'), noteT: 0 };
  ui.end.onclick = () => end();
  ui.mute.onclick = toggleMute;
  return ui;
}
function note(t) { if (!ui) return; ui.note.textContent = t; ui.note.classList.add('show'); clearTimeout(ui.noteT); ui.noteT = setTimeout(() => ui.note.classList.remove('show'), 3200); }
function paint() {
  if (!S || !ui) return;
  const n = S.c ? (typeof dispName === 'function' ? dispName(S.c) : S.c.name) : '';
  const txt = {
    connecting: 'Menyambungkan…',
    listening: S.muted ? 'Mikrofon dimatikan' : (full() ? 'Mendengarkan…' : 'Giliranmu, ngomong aja'),
    thinking: n + ' lagi mikir…',
    speaking: n + ' lagi bicara. Tunggu giliranmu'
  }[S.state] || '';
  ui.status.textContent = txt;
  ui.el.dataset.state = S.state; ui.el.classList.toggle('muted', S.muted);
  ui.mute.setAttribute('aria-pressed', S.muted ? 'true' : 'false'); ui.mute.disabled = S.state !== 'listening';
  paintYou();
}
function paintYou() {
  if (!ui || !S) return;
  const t = S.state === 'listening' ? full() : '';
  ui.you.textContent = t.length > 160 ? '…' + t.slice(-158) : t;
}
const full = () => S ? join(S.fin, join(S.cur.f, S.cur.i)) : '';

/* ---------- Mulai / akhiri ---------- */
async function start() {
  if (S) return;
  if (!unlocked() || !ch || !app.classList.contains('open') || (window.GX && GX.cur)) return;
  if (!SR) { toast('Browser ini belum mendukung suara ke teks. Pakai Chrome, Edge, atau Safari terbaru.'); return; }
  if (!window.isSecureContext) { toast('Telepon butuh koneksi aman (https)'); return; }
  const el = new Audio(); el.src = SILENT; const pr = el.play(); if (pr && pr.catch) pr.catch(() => {}); // harus sinkron di dalam ketukan user
  if (current) current.stop();
  if (pend.length) await pendFlush(false); // pesan yang masih mengantre dikirim dulu
  if (busy) { toast(ch.name + ' masih membalas, tunggu sebentar'); return; }
  const c = ch;
  S = { chId: c.id, c, state: 'connecting', fin: '', cur: { f: '', i: '' }, last: 0, rec: null, muted: false, ended: false, el, turns: 0, fast: 0, t0: Date.now(), stopAudio: null, stopTts: null, tick: 0 };
  const u = build();
  u.name.textContent = typeof dispName === 'function' ? dispName(c) : c.name;
  u.av.textContent = ''; u.av.append(img(c, 'cl-av'));
  u.cap.textContent = ''; u.you.textContent = ''; u.time.textContent = '0:00'; u.bar.style.width = '0%'; u.note.classList.remove('show');
  u.el.classList.remove('hide'); void u.el.offsetWidth; u.el.classList.add('on');
  busy = true; refresh(); // chat di belakang layar tidak bisa dikirimi apa pun selama telepon
  paint();
  S.tick = setInterval(onTick, 100);
  const me = S;
  setTimeout(() => { if (S === me && !me.ended) { me.state = 'listening'; me.last = 0; paint(); listen(); } }, CFG.CONNECT_MS);
}

function end(why) {
  if (!S) return;
  const s = S; s.ended = true; clearInterval(s.tick);
  try { s.rec && s.rec.abort(); } catch {}
  s.rec = null;
  if (s.stopAudio) s.stopAudio();
  if (s.stopTts) s.stopTts();
  try { s.el.pause(); s.el.removeAttribute('src'); } catch {}
  try { window.speechSynthesis && speechSynthesis.cancel(); } catch {}
  const inflight = s.state === 'thinking'; // permintaan ke AI masih jalan: busy dilepas oleh turn() setelah balasannya dicatat
  S = null;
  if (ui) { ui.el.classList.remove('on'); setTimeout(() => { if (!S) ui.el.classList.add('hide'); }, 220); }
  if (!inflight) { busy = false; refresh(); }
  if (why) toast(why); else toast('Telepon berakhir · ' + clock((Date.now() - s.t0) / 1000));
}

function toggleMute() {
  if (!S || S.state !== 'listening') return;
  S.muted = !S.muted;
  if (S.muted) { try { S.rec && S.rec.abort(); } catch {} S.rec = null; }
  else { S.last = full() ? Date.now() : 0; listen(); }
  paint();
}

/* ---------- Mendengarkan ---------- */
function listen() {
  if (!S || S.ended || S.muted || S.rec || S.state !== 'listening') return;
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
  };
  r.onend = () => {
    if (S !== s || s.rec !== r) return;
    s.fin = join(s.fin, join(s.cur.f, s.cur.i)); s.cur = { f: '', i: '' }; s.rec = null; // browser menutup sesi sendiri saat hening: teks disimpan, sesi baru dibuka
    s.fast = Date.now() - born < 350 ? s.fast + 1 : 0;
    if (s.state === 'listening' && !s.muted && !s.ended) setTimeout(listen, s.fast >= 3 ? 1200 : 120);
  };
  try { r.start(); } catch { s.rec = null; setTimeout(listen, 500); }
}

function onTick() {
  if (!S) return;
  const s = S;
  if (s.state === 'connecting') { ui.time.textContent = '0:00'; return; }
  ui.time.textContent = clock((Date.now() - s.t0) / 1000);
  if (s.state !== 'listening' || s.muted) { ui.bar.style.width = '0%'; return; }
  const txt = full();
  if (txt.length < CFG.MIN_CHARS || !s.last) { ui.bar.style.width = '0%'; return; }
  const idle = Date.now() - s.last;
  ui.bar.style.width = Math.min(100, idle / CFG.SILENCE_MS * 100) + '%';
  if (idle > 700) ui.status.textContent = 'Kamu diam… mengirim dalam ' + Math.max(1, Math.ceil((CFG.SILENCE_MS - idle) / 1000)) + ' dtk';
  if (idle >= CFG.SILENCE_MS) turn(txt);
}

/* ---------- Satu giliran: kirim ke AI, lalu AI bicara ---------- */
async function turn(raw) {
  const s = S; if (!s || s.state !== 'listening') return;
  const chId = s.chId, text = raw.trim().charAt(0).toUpperCase() + raw.trim().slice(1);
  const say = text.slice(0, CFG.MAX_SAY);
  s.state = 'thinking'; s.turns++;
  try { s.rec && s.rec.abort(); } catch {} s.rec = null; // mikrofon mati: user tidak bisa membalas sampai AI selesai
  s.fin = ''; s.cur = { f: '', i: '' }; s.last = 0;
  ui.bar.style.width = '0%'; ui.cap.textContent = ''; ui.cap.classList.remove('talk');
  paint();
  if (stillHere(chId)) addText(say);
  record(chId, { r: 'me', x: say });
  const useVoice = voiceOn && !!vcode && canVoice(chId), lang = voiceLang;
  let r = null, relNote = '';
  try {
    r = await (await post('/api/chat', {
      clientId: cid, char: chId, message: (CFG.HINT ? HINT + '\n' : '') + say, userName: uname, history: loadHist(chId),
      voice: { on: useVoice, lang }, memory: memUse(chId).list, rel: relPayload(chId), qr: true, ...engPayload(), ...(rpOn() ? { rp: true } : {})
    })).json();
    saveHist(chId, [...loadHist(chId), ['user', say], ['char', r.id]]); // riwayat memakai teks asli user, tanpa petunjuk telepon
    relNote = relApply(chId, r.dExp != null ? r.dExp : (Math.round(Number(r.dRel)) || 0) * 3, r.dMood);
  } catch (e) {
    r = null;
    if (S === s) note(e.message || 'Gagal terhubung'); else toast(e.message || 'Gagal terhubung');
  }
  if (r) {
    if (S === s && !s.ended) {
      s.state = 'speaking'; paint();
      try { await speak(s, chId, r, useVoice, lang); } catch (e) { note(e.message || 'Suara gagal'); }
    } else {
      showThemSafe(chId, r.id); // telepon sudah ditutup saat menunggu: balasan tetap masuk obrolan sebagai teks
    }
    if (typeof maybeMemorize === 'function') maybeMemorize(chId);
    if (Array.isArray(r.nq)) r.nq.forEach((tt, i) => setTimeout(() => (S ? note(tt) : toast(tt)), 600 + i * 2300));
    if (relNote) { if (S === s) note(relNote); else toast(relNote); }
  }
  if (S !== s) { busy = false; refresh(); return; } // telepon sudah diakhiri
  s.state = 'speaking'; paint();
  await new Promise(res => setTimeout(res, CFG.RESUME_MS));
  if (S !== s) return;
  s.state = 'listening'; s.last = 0; ui.cap.classList.remove('talk'); paint(); listen(); // giliran kembali ke user
}

/* ---------- AI bicara ---------- */
const sleep = ms => new Promise(res => setTimeout(res, ms));
function playUrl(s, url) {
  return new Promise(res => {
    const a = s.el; let done = false;
    const fin = () => { if (done) return; done = true; s.stopAudio = null; a.onended = a.onerror = null; res(); };
    s.stopAudio = () => { try { a.pause(); } catch {} fin(); };
    a.onended = fin; a.onerror = fin;
    a.src = url; const p = a.play(); if (p && p.catch) p.catch(fin);
  });
}
function speakSynth(s, text) { // tanpa voice AI: dibacakan suara bawaan browser
  return new Promise(res => {
    const synth = window.speechSynthesis; let done = false;
    const fin = () => { if (done) return; done = true; s.stopTts = null; clearTimeout(guard); res(); };
    const guard = setTimeout(fin, Math.max(2500, text.length * 110 + 2500)); // onend tidak selalu datang di semua browser
    if (!synth || !text) { setTimeout(fin, Math.max(1500, text.length * 55)); s.stopTts = fin; return; } // tanpa suara browser: beri waktu baca
    const u = new SpeechSynthesisUtterance(text); u.lang = store.get('sttlang') || 'id-ID'; u.onend = fin; u.onerror = fin;
    s.stopTts = () => { try { synth.cancel(); } catch {} fin(); };
    try { synth.cancel(); synth.speak(u); } catch { fin(); }
  });
}
async function speak(s, chId, r, useVoice, lang) {
  const cap = t => { if (S === s) { ui.cap.textContent = plain(t); ui.cap.classList.add('talk'); } };
  if (!useVoice) {
    showThemSafe(chId, r.id); cap(r.id);
    await speakSynth(s, plain(r.id));
    return;
  }
  const parts = (r.parts && r.parts.length > 1) ? r.parts : [{ id: r.id, jp: r.jpText, vn: r.vn }];
  let i = 0;
  try {
    for (; i < parts.length; i++) {
      if (S !== s || s.ended) break;
      const p = parts[i];
      const ab = await (await post('/api/tts', { char: chId, text: p.vn, voice: voiceKeyOf(chId) }, { 'x-voice-code': vcode })).arrayBuffer();
      const pre = await decode(ab); urls.push(pre.url);
      const tNow = Date.now(), k = newKey(), here = stillHere(chId);
      if (here) addVN({ id: p.id, jp: p.jp, lang, vn: p.vn }, [pre], tNow); // voice note yang sama seperti chat biasa, bisa diputar ulang nanti
      const saved = await idb.put(k, { ab, dur: pre.dur, bins: pre.bins });
      if (saved) pre.k = k;
      record(chId, { t: tNow, r: 'vn', x: p.id, jp: p.jp, lang, vn: p.vn, ...(saved ? { ks: [k], si: 0 } : {}) });
      if (S === s && !s.ended) { cap(p.id); await playUrl(s, pre.url); }
      if (S === s && i < parts.length - 1) await sleep(250);
    }
    i = parts.length;
  } catch (e) {
    if (e.status === 403) { vcode = ''; voiceOn = false; store.set('vcode', null); store.set('von', '0'); paintVoice(); note('Kode voice tidak valid, voice dimatikan'); }
    else note(e.message || 'Suara gagal dibuat');
    for (let j = i; j < parts.length; j++) { showThemSafe(chId, parts[j].id); if (j === i) cap(parts[j].id); } // suara gagal: teksnya tetap tampil dan masuk obrolan
    if (S === s) await speakSynth(s, plain(parts[i] && parts[i].id));
    return;
  }
  for (let j = i; j < parts.length; j++) showThemSafe(chId, parts[j].id); // telepon ditutup di tengah: sisa balasan masuk obrolan sebagai teks
}

window.addEventListener('pagehide', () => { if (S) end('Telepon berakhir'); });
document.addEventListener('visibilitychange', () => { if (document.hidden && S && S.state === 'listening') { try { S.rec && S.rec.abort(); } catch {} } }); // tab disembunyikan: sesi dengar dibuka lagi lewat onend/listen saat kembali
document.addEventListener('visibilitychange', () => { if (!document.hidden && S && S.state === 'listening' && !S.rec && !S.muted) listen(); });
})();
