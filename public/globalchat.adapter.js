/* ===== Chat Global: adapter sungguhan (backend: MongoDB + Redis) =====
   Pengganti globalchat.mock.js. Kontrak ke UI (globalchat.js) sama seperti yang didokumentasikan di kepala file mock:
   setSelf, getState, subscribe, connect, reconnect, send, retry, deleteMessage, clearAll, ditambah keepAlive dan
   loadOlder (pagination). Tidak ada properti `dev` -> bagian simulasi di panel Dev otomatis disembunyikan UI.

   Arsitektur:
   - Riwayat penuh: MongoDB di server (koleksi gc_messages). Browser memuat halaman terbaru lewat /api/gc/history saat
     terhubung, dan halaman yang lebih lama saat pengguna menggulir ke atas (loadOlder). Tidak ada penyimpanan lokal.
   - Pesan baru: polling adaptif ke /api/gc/sync (feed 10 pesan terbaru di Redis; kalau tertinggal server menambal dari Mongo),
     cepat (burst) saat ramai dan melambat saat sepi. Presence + rate-limit juga di Redis.
   - Penghapusan (Mode dev): dihapus di Mongo + tombstone di Redis; klien yang online membuangnya lewat sync. */

(() => {
'use strict';

/* ---------- konstanta & util ---------- */
const PAGE = 30;                // jumlah pesan per halaman riwayat
const MEM_MAX = 3000;           // batas pesan di memori (pesan terlama dibuang; bisa dimuat lagi lewat loadOlder)
const IDLE_SLEEP = 60000;       // ruang ditutup -> benar-benaran tidur setelah 60 dtk
const FAIL_N = 2;               // berapa kali poll gagal berturut-turut -> offline

const CID_RE = /^[\w-]{8,64}$/;
const MID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const cmp = (a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const uid = () => Math.random().toString(36).slice(2, 10);
const okShape = m => m && typeof m === 'object' &&
  typeof m.id === 'string' && MID_RE.test(m.id) &&
  typeof m.senderId === 'string' && CID_RE.test(m.senderId) &&
  typeof m.senderName === 'string' && m.senderName.length > 0 && m.senderName.length <= 24 &&
  typeof m.text === 'string' && m.text.length > 0 && [...m.text].length <= 256 &&
  Number.isInteger(m.ts) && m.ts > 1600000000000 && m.ts < 9e15 &&
  (m.replyTo == null || (typeof m.replyTo === 'string' && MID_RE.test(m.replyTo)));

async function api(path, body) {
  try {
    const tok = path === '/api/gc/send' && typeof atok === 'string' && atok; // token akun: server memakai nama + foto profil sebagai identitas pengirim
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, json: j };
  } catch { return { ok: false, status: 0, json: null }; }
}

/* ---------- state (kontrak view model UI) ---------- */
// more = masih ada riwayat lebih lama di server; loadingOlder = sedang mengambil halaman lama
const st = { status: 'offline', error: null, onlineCount: null, sync: null, rev: 0, messages: [], more: false, loadingOlder: false };
const subs = new Set();
const emit = () => subs.forEach(f => { try { f(st) } catch {} });
function touch() { st.rev++; st.messages = [...msgsArr, ...pending].sort(cmp); emit(); }

let getSelf = () => ({ id: (typeof cid !== 'undefined' && cid) || 'self', name: (typeof uname !== 'undefined' && uname) || 'Tamu' });
const meId = () => getSelf().id;

let msgsArr = [], pending = [];         // msgsArr: pesan dari server (urut naik); pending: sementara milik sendiri
const ids = new Set();
let tombs = new Set();                  // id yang dihapus selama sesi ini
let wm = 0, tombTs = 0;                 // watermark "hapus semua" + titik awal tombstone berikutnya

function setStatus(s, err) {
  if (st.status === s && st.error === (err || null)) return;
  st.status = s; st.error = err || null;
  if (s === 'offline') st.onlineCount = null;
  touch();
}

/* ---------- penggabungan pesan (dedup + tombstone) ---------- */
// trim=false dipakai loadOlder: halaman lama yang baru dimuat tidak boleh langsung terbuang oleh batas memori.
function ingest(list, trim = true) {
  const cand = (Array.isArray(list) ? list : []).filter(m => okShape(m) && !ids.has(m.id) && !tombs.has(m.id) && m.ts > wm);
  if (!cand.length) return [];
  msgsArr = [...msgsArr, ...cand].sort(cmp);
  for (const m of cand) ids.add(m.id);
  if (trim && msgsArr.length > MEM_MAX) { for (const m of msgsArr.slice(0, msgsArr.length - MEM_MAX)) ids.delete(m.id); msgsArr = msgsArr.slice(-MEM_MAX); st.more = true; }
  touch();
  return cand;
}

function applyTombs(list, newWm) {
  let changed = false;
  for (const id of (Array.isArray(list) ? list : [])) if (typeof id === 'string' && !tombs.has(id)) { tombs.add(id); changed = true; }
  if (Number(newWm) > wm) { wm = Number(newWm); changed = true; }
  if (!changed) return false;
  const bad = msgsArr.filter(m => tombs.has(m.id) || m.ts <= wm);
  if (bad.length) { msgsArr = msgsArr.filter(m => !tombs.has(m.id) && m.ts > wm); for (const m of bad) ids.delete(m.id); }
  touch();
  return true;
}
function tombsFromServer(flat, newWm) { // [id, skor, id, skor, ...] -> terapkan + majukan penanda waktu
  const list = [];
  for (let i = 0; i + 1 < flat.length; i += 2) { list.push(flat[i]); const s = Number(flat[i + 1]); if (s > tombTs) tombTs = s; }
  return applyTombs(list, newWm);
}

/* ---------- riwayat (MongoDB, per halaman) ---------- */
const OFF_MSG = 'Chat global belum aktif di server (butuh Redis dan MongoDB, lihat README)';
let loaded = false;

// Halaman terbaru: dipanggil sekali (diulang oleh beat kalau gagal). true = sukses, 'off' = fitur nonaktif di server, false = gagal.
async function loadFirst() {
  const r = await api('/api/gc/history', { clientId: meId(), limit: PAGE });
  if (r.json && r.json.enabled === false) return 'off';
  if (!r.ok || !r.json || !Array.isArray(r.json.msgs)) return false;
  wm = Math.max(wm, Number(r.json.wm) || 0);
  tombTs = Math.max(tombTs, Number(r.json.t0) || 0); // penghapusan sesudah titik ini datang lewat sync
  ingest(r.json.msgs);
  st.more = !!r.json.more; loaded = true; touch();
  return true;
}

// Halaman yang lebih lama dari pesan tertua yang dimiliki. Mengembalikan jumlah pesan yang bertambah.
async function loadOlder() {
  if (st.loadingOlder || !st.more || !loaded || !msgsArr.length) return 0;
  const o = msgsArr[0];
  st.loadingOlder = true;
  const r = await api('/api/gc/history', { clientId: meId(), before: { ts: o.ts, id: o.id }, limit: PAGE });
  st.loadingOlder = false;
  if (!r.ok || !r.json || !Array.isArray(r.json.msgs)) { touch(); return 0; } // gagal: `more` tetap true, bisa dicoba lagi
  const added = ingest(r.json.msgs, false);
  st.more = !!r.json.more; touch();
  return added.length;
}

/* ---------- polling adaptif ---------- */
let POLL = { base: 10000, burst: 3000 };
let alive = false, booted = false, sleeping = false, failN = 0, delay = 10000, beatT = 0, serverDevHash = 0;

const bump = () => { delay = POLL.burst; }; // ada aktivitas -> polling cepat sebentar

async function beat() {
  if (!alive) return;
  if (!loaded) {
    const ok = await loadFirst();
    if (!alive) return;
    if (ok === 'off') { setStatus('offline', OFF_MSG); alive = false; return; }
    if (!ok) { failed(); return schedule(); }
  }
  const prevMax = msgsArr.length ? msgsArr[msgsArr.length - 1].ts : 0;
  const r = await api('/api/gc/sync', { clientId: meId(), since: Math.max(0, prevMax - 1), tombSince: tombTs });
  if (!alive) return;
  if (!r.ok || !r.json) { failed(); return schedule(); }
  const j = r.json;
  if (j.enabled === false) { setStatus('offline', OFF_MSG); alive = false; return; }
  if (j.poll) POLL = { base: Math.max(3000, j.poll.base | 0), burst: Math.max(1500, j.poll.burst | 0) };
  if (j.devHash) serverDevHash = Number(j.devHash) || 0;
  failN = 0;
  tombsFromServer(j.tombs || [], j.wm);
  const added = ingest(j.msgs);
  st.onlineCount = j.count || 0;
  if (st.status !== 'online') setStatus('online');
  if (added.length || j.more) bump(); // pesan baru / masih ada sisa -> polling cepat sebentar
  touch();
  schedule();
}
function failed() { if (++failN >= FAIL_N) setStatus('offline', 'Gagal terhubung ke chat global'); }
function schedule() {
  clearTimeout(beatT);
  if (!alive) return;
  let d;
  if (st.status === 'offline') d = 15000; // tetap mencoba diam-diam sampai berhasil
  else { delay = Math.min(delay + 1000, POLL.base); d = delay; }
  if (document.hidden) d = Math.max(d, 30000);
  beatT = setTimeout(beat, d);
}

/* ---------- Mode dev: kode & penghapusan ----------
   Kode ditangkap saat Mode dev dibuka (pembungkus GX.hash, hasil tidak berubah), atau diminta lewat
   prompt bila halaman dimuat ulang setelah Mode dev aktif. Validasi sebenarnya tetap di backend. */
let devCode = null;
try {
  if (window.GX && typeof GX.hash === 'function') {
    const orig = GX.hash;
    GX.hash = s => { const r = orig(s); if (typeof s === 'string' && s.trim() && (r === 3608493969801461 || (serverDevHash && r === serverDevHash))) devCode = s.trim(); return r; };
  }
} catch {}
function askCode() {
  if (devCode) return devCode;
  const c = prompt('Masukkan kode dev untuk menghapus pesan Chat Global:');
  return c && c.trim() ? c.trim() : null;
}

async function deleteMessage(id) {
  if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) return;
  const code = askCode(); if (!code) return;
  const snap = msgsArr.filter(m => m.id === id);        // optimistis: hilangkan dulu, kembalikan kalau ditolak
  msgsArr = msgsArr.filter(m => m.id !== id); ids.delete(id); touch();
  const r = await api('/api/gc/delete', { code, id });
  if (!r.ok || !r.json?.ok) { msgsArr = [...msgsArr, ...snap].sort(cmp); for (const m of snap) ids.add(m.id); return touch(); }
  devCode = code;
  tombs.add(id); if (r.json.wm > wm) wm = r.json.wm;
  touch();
}

async function clearAll() {
  const code = askCode(); if (!code) return;
  const snap = msgsArr;
  msgsArr = []; ids.clear(); st.more = false; touch();
  const r = await api('/api/gc/delete', { code, all: 1 });
  if (!r.ok || !r.json?.ok) { msgsArr = snap; for (const m of snap) ids.add(m.id); return touch(); }
  devCode = code;
  wm = Math.max(wm, r.json.wm || 0);
  touch();
}

/* ---------- kirim pesan ---------- */
const canSend = () => st.status === 'online';
function failTmp(m, why) { const p = pending.find(x => x.id === m.id); if (!p) return; p.status = 'failed'; p.err = why || 'Gagal terkirim'; touch(); }
function dropTmp(m) { pending = pending.filter(x => x.id !== m.id); touch(); }

// replyTo (opsional): id pesan yang dibalas. Sudah diteruskan ke server dan disimpan; belum ada UI-nya.
function send(text, replyTo) {
  if (!canSend() || typeof text !== 'string' || !text.trim()) return null;
  const s = getSelf();
  const tmp = { id: 'tmp-' + uid(), senderId: s.aid || s.id, senderName: s.name, text, ts: Date.now(), status: 'sending', replyTo: MID_RE.test(replyTo || '') ? replyTo : null };
  pending.push(tmp); touch(); bump();
  deliver(text, tmp);
  return tmp;
}
async function deliver(text, tmp) {
  const t = setTimeout(() => { if (pending.some(x => x.id === tmp.id && x.status === 'sending')) failTmp(tmp); }, 15000);
  const r = await api('/api/gc/send', { clientId: meId(), name: getSelf().name, text, replyTo: tmp.replyTo });
  clearTimeout(t);
  if (!pending.some(x => x.id === tmp.id)) return; // sudah dibersihkan (mis. dicoba ulang)
  if (r.ok && r.json?.m) { dropTmp(tmp); ingest([r.json.m]); }
  else failTmp(tmp, r.json?.error);
}

function retry(id) {
  const m = pending.find(x => x.id === id);
  if (!m || m.status !== 'failed' || !canSend()) return;
  m.status = 'sending'; touch(); bump();
  deliver(m.text, m);
}

/* ---------- siklus hidup ---------- */
function sleep() { if (!booted) return; sleeping = true; alive = false; clearTimeout(beatT); setStatus('offline', null); }
function wake() { if (!booted) return; sleeping = false; alive = true; failN = 0; if (st.status !== 'online') setStatus('connecting'); beat(); }

let life = false, bg = false, sleepT = 0; // bg: mode notifikasi, koneksi tetap hidup walau ruang chat global ditutup
function setupLifecycle() {
  if (life) return; life = true;
  const gcEl = document.getElementById('gc');
  if (gcEl) {
    new MutationObserver(() => {
      if (gcEl.classList.contains('show')) { clearTimeout(sleepT); if (sleeping || !alive) wake(); }
      else if (!bg) sleepT = setTimeout(sleep, IDLE_SLEEP); // buka-tutup cepat tidak memutus koneksi; mode notifikasi tidak pernah tidur
    }).observe(gcEl, { attributes: true, attributeFilter: ['class'] });
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && alive) { clearTimeout(beatT); beat(); } });
}

/* ---------- adapter (kontrak UI) ---------- */
const A = window.GlobalChatAdapter = {
  setSelf(fn) { if (typeof fn === 'function') getSelf = fn; },
  getState: () => st,
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  connect() { // dipanggil sekali saat UI pertama dibuka; riwayat dimuat di beat() pertama
    if (booted) return; booted = true;
    setupLifecycle();
    setStatus('connecting');
    alive = true; delay = POLL.burst;
    beat();
  },
  keepAlive(on) { // notifikasi menyala -> tetap sinkron di latar belakang; mati -> boleh tidur seperti biasa
    bg = !!on; clearTimeout(sleepT);
    if (bg) { if (!booted) A.connect(); else if (sleeping || !alive) wake(); }
    else { const g = document.getElementById('gc'); if (booted && !(g && g.classList.contains('show'))) sleepT = setTimeout(sleep, IDLE_SLEEP); }
  },
  reconnect() {
    if (!booted) return A.connect();
    if (sleeping || !alive) return wake();
    failN = 0; clearTimeout(beatT);
    if (st.status !== 'online') setStatus('connecting');
    beat();
  },
  send,
  retry,
  loadOlder,
  deleteMessage,
  clearAll,
  debug: () => ({ status: st.status, msgs: msgsArr.length, pending: pending.length, more: st.more, tombs: tombs.size, wm, tombTs, poll: POLL, alive })
};
})();
