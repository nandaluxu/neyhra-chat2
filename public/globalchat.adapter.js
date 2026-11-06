/* ===== Chat Global: adapter sungguhan (backend + P2P) =====
   Pengganti globalchat.mock.js. Kontrak ke UI (globalchat.js) persis sama seperti yang didokumentasikan
   di kepala file mock: setSelf, getState, subscribe, connect, reconnect, send, retry, deleteMessage,
   clearAll. Tidak ada properti `dev` -> bagian simulasi di panel Dev otomatis disembunyikan UI;
   tombol hapus (per pesan / semua) tetap jalan lewat deleteMessage/clearAll.

   Arsitektur hybrid (Redis + WebRTC):
   - Riwayat penuh: IndexedDB perangkat ini (db "neyhra-gc", maks 2000 pesan; tampilan 300 terakhir).
   - Redis (via /api/gc/*): maks 10 pesan terbaru TTL 24 jam -> jalur bootstrap & fallback, bukan storage utama.
   - WebRTC DataChannel: tukar-menukar riwayat antar browser + dorong pesan baru secara realtime (relay terbatas).
   - Polling adaptif: hanya jalan saat ruang dibuka; cepat (burst) saat ramai, melambat saat sepi.
   - Setiap pesan ditandatangani server (ECDSA P-256); pesan dari peer diverifikasi dulu sebelum diterima.
   - Penghapusan (Mode dev): tombstone persisten (watermark + daftar id) sehingga pesan terhapus tidak
     bisa muncul lagi dari IndexedDB, Redis, maupun transfer P2P. */

(() => {
'use strict';

/* ---------- konstanta & util ---------- */
const PEERS_MAX = 3;            // jumlah koneksi P2P yang dijaga
const FRAME_MAX = 40960;        // batas ukuran satu frame DataChannel
const BATCH = 25;               // maks pesan per transfer (batch, bukan sekali jalan)
const HOPS = 3;                 // batas relay pesan realtime di dalam mesh
const LOCAL_MAX = 2000;         // batas riwayat di IndexedDB
const SHOW_MAX = 300;           // batas pesan yang dirender UI
const CONNECT_MS = 30000;       // batas waktu membuka koneksi peer (harus > 2x interval polling: penawaran
                                // dan jawaban masing-masing menunggu giliran poll penerima sebelum sampai)
const SYNC_MS = 20000;          // batas waktu status "syncing" sebelum dipaksa online
const IDLE_SLEEP = 60000;       // ruang ditutup -> benar-benaran tidur setelah 60 dtk
const FAIL_N = 2;               // berapa kali poll gagal berturut-turut -> offline

const CID_RE = /^[\w-]{8,64}$/;
const MID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
// CATATAN STUN/TURN: STUN publik cukup untuk mayoritas jaringan. TURN tidak dipasang (berbayar);
// kalau P2P gagal (mis. NAT simetris), chat tetap jalan lewat jalur polling Redis, hanya tidak realtime.

const cmp = (a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const uid = () => Math.random().toString(36).slice(2, 10);
const okShape = m => m && typeof m === 'object' &&
  typeof m.id === 'string' && MID_RE.test(m.id) &&
  typeof m.senderId === 'string' && CID_RE.test(m.senderId) &&
  typeof m.senderName === 'string' && m.senderName.length > 0 && m.senderName.length <= 24 &&
  typeof m.text === 'string' && m.text.length > 0 && [...m.text].length <= 256 &&
  Number.isInteger(m.ts) && m.ts > 1600000000000 && m.ts < 9e15 &&
  typeof m.sig === 'string' && m.sig.length >= 80 && m.sig.length <= 140;

async function api(path, body) {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, json: j };
  } catch { return { ok: false, status: 0, json: null }; }
}

/* ---------- IndexedDB (riwayat lokal) ---------- */
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const q = indexedDB.open('neyhra-gc', 1);
    q.onupgradeneeded = () => {
      const msgs = q.result.createObjectStore('msgs', { keyPath: 'id' });
      msgs.createIndex('ts', 'ts');
      q.result.createObjectStore('meta', { keyPath: 'k' });
    };
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  }).catch(e => { dbp = null; throw e });
  return dbp;
}

const dirty = new Map(); let flushT = 0, flushN = 0;
function idbQueue(m) { dirty.set(m.id, m); clearTimeout(flushT); flushT = setTimeout(flush, 800); }
async function flush() {
  if (!dirty.size) return;
  const batch = [...dirty.values()]; dirty.clear();
  try {
    const d = await db(), tx = d.transaction('msgs', 'readwrite'), st = tx.objectStore('msgs');
    for (const m of batch) st.put(m);
    if (++flushN % 10 === 0) { // sesekali pangkas supaya IndexedDB tidak membengkak
      const q = st.index('ts').getAllKeys();
      q.onsuccess = () => { const keys = q.result || []; for (let i = 0; i < keys.length - LOCAL_MAX; i++) st.delete(keys[i]); };
    }
  } catch {}
}
async function idbDel(ids) { if (!ids.length) return; try { const d = await db(), tx = d.transaction('msgs', 'readwrite'), st = tx.objectStore('msgs'); for (const id of ids) st.delete(id); } catch {} }
let metaT = 0;
function persistMeta() {
  clearTimeout(metaT);
  metaT = setTimeout(async () => {
    try { const d = await db(), tx = d.transaction('meta', 'readwrite'), st = tx.objectStore('meta');
      st.put({ k: 'wm', v: wm }); st.put({ k: 'tts', v: tombTs }); st.put({ k: 'tombs', v: [...tombs].slice(-5000) });
    } catch {}
  }, 300);
}
async function initStore() {
  try {
    const d = await db(), tx = d.transaction(['msgs', 'meta'], 'readonly');
    const get = (store, key) => new Promise(res => { const q = tx.objectStore(store).get(key); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
    const getAll = () => new Promise(res => { const q = tx.objectStore('msgs').getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); });
    const [msgs, wmV, tbV, ttV] = await Promise.all([getAll(), get('meta', 'wm'), get('meta', 'tombs'), get('meta', 'tts')]);
    wm = (wmV && wmV.v) || 0; tombTs = (ttV && ttV.v) || 0;
    tombs = new Set((tbV && tbV.v) || []);
    const keep = new Set();
    const valid = (msgs || []).filter(m => okShape(m) && !tombs.has(m.id) && m.ts > wm);
    msgsArr = valid.sort(cmp).slice(-LOCAL_MAX);
    for (const m of msgsArr) { ids.add(m.id); keep.add(m.id); }
    const junk = (msgs || []).filter(m => !keep.has(m.id)).map(m => m.id); // self-heal: record terhapus/kedaluwarsa
    if (junk.length) idbDel(junk);
  } catch { msgsArr = []; tombs = new Set(); wm = 0; }
}

/* ---------- verifikasi tanda tangan (ECDSA P-256 via WebCrypto) ---------- */
let PUB = '', vkey = null, serverDevHash = 0;
async function verifyKey() {
  if (vkey) return vkey;
  if (!PUB || !crypto.subtle) return null; // konteks tanpa WebCrypto: terima (jalur ini sudah DTLS/HTTPS)
  try { vkey = await crypto.subtle.importKey('spki', Uint8Array.from(atob(PUB), c => c.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']); }
  catch { vkey = null; }
  return vkey;
}
async function verifyBatch(list) {
  const key = await verifyKey();
  if (!key) return list;
  const enc = new TextEncoder(), out = [];
  for (const m of list) {
    try {
      const sig = Uint8Array.from(atob(m.sig), c => c.charCodeAt(0));
      if (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig,
        enc.encode(JSON.stringify([m.id, m.senderId, m.senderName, m.ts, m.text])))) out.push(m);
    } catch {}
  }
  return out;
}

/* ---------- state (kontrak view model UI) ---------- */
const st = { status: 'offline', error: null, onlineCount: null, sync: null, rev: 0, messages: [] };
const subs = new Set();
const emit = () => subs.forEach(f => { try { f(st) } catch {} });
function touch() { st.rev++; st.messages = [...msgsArr, ...pending].sort(cmp).slice(-SHOW_MAX); emit(); }

let getSelf = () => ({ id: (typeof cid !== 'undefined' && cid) || 'self', name: (typeof uname !== 'undefined' && uname) || 'Tamu' });
const meId = () => getSelf().id;

let msgsArr = [], pending = [];         // msgsArr: pesan terkonfirmasi server; pending: sementara milik sendiri
const ids = new Set();
let tombs = new Set();
let wm = 0, tombTs = 0;
const cool = new Map();                 // cooldown per peer yang gagal terhubung

function setStatus(s, err) {
  if (st.status === s && st.error === (err || null)) return;
  st.status = s; st.error = err || null;
  if (s !== 'syncing') { st.sync = null; stopWatchdogs(); }
  if (s === 'offline') st.onlineCount = null;
  touch();
}

/* ---------- penggabungan pesan (dedup + tombstone) ---------- */
async function ingest(list, fromPeer) {
  let cand = (Array.isArray(list) ? list : []).filter(m => okShape(m) && !ids.has(m.id) && !tombs.has(m.id) && m.ts > wm);
  cand = fromPeer ? await verifyBatch(cand) : cand; // jalur server dipercaya (HTTPS + id buatan server)
  if (!cand.length) return [];
  msgsArr = [...msgsArr, ...cand].sort(cmp).slice(-LOCAL_MAX);
  for (const m of cand) { ids.add(m.id); idbQueue(m); }
  if (st.sync) st.sync = { ...st.sync, done: Math.min(msgsArr.length, st.sync.total) };
  touch();
  return cand;
}

function applyTombs(list, newWm) {
  let changed = false;
  for (const id of (Array.isArray(list) ? list : [])) if (typeof id === 'string' && !tombs.has(id)) { tombs.add(id); changed = true; }
  if (Number(newWm) > wm) { wm = Number(newWm); changed = true; }
  if (!changed) return false;
  const bad = msgsArr.filter(m => tombs.has(m.id) || m.ts <= wm);
  if (bad.length) { msgsArr = msgsArr.filter(m => !tombs.has(m.id) && m.ts > wm); for (const m of bad) ids.delete(m.id); idbDel(bad.map(m => m.id)); }
  persistMeta(); touch();
  return true;
}
function tombsFromServer(flat) { // [id, skor, id, skor, ...] -> terapkan + majukan penanda waktu
  const list = [];
  for (let i = 0; i + 1 < flat.length; i += 2) { list.push(flat[i]); const s = Number(flat[i + 1]); if (s > tombTs) tombTs = s; }
  return applyTombs(list, wm);
}

/* ---------- polling adaptif ---------- */
let POLL = { base: 10000, burst: 3000 };
let alive = false, booted = false, sleeping = false, failN = 0, delay = 10000, beatT = 0, syncT = 0, watchT = 0, syncStart = 0, lastPeerList = [];

const bump = () => { delay = POLL.burst; }; // ada aktivitas -> polling cepat sebentar

async function beat() {
  if (!alive) return;
  const prevMax = msgsArr.length ? msgsArr[msgsArr.length - 1].ts : 0;
  const r = await api('/api/gc/sync', { clientId: meId(), since: Math.max(0, prevMax - 1), tombSince: tombTs });
  if (!alive) return;
  if (!r.ok || !r.json) { failed(); return schedule(); }
  const j = r.json;
  if (j.enabled === false) { setStatus('offline', 'Chat global belum aktif di server (butuh Redis, lihat README)'); alive = false; return; }
  if (j.poll) POLL = { base: Math.max(3000, j.poll.base | 0), burst: Math.max(1500, j.poll.burst | 0) };
  if (j.pub && j.pub !== PUB) { PUB = j.pub; vkey = null; }
  if (j.devHash) serverDevHash = Number(j.devHash) || 0;
  failN = 0;
  if (st.status === 'offline') setStatus('connecting');
  tombsFromServer(j.tombs || []);
  const added = await ingest(j.msgs, false);
  st.onlineCount = j.count || 0;
  for (const s of (j.sigs || [])) onSignal(s);
  lastPeerList = j.peers || [];
  maintainMesh(lastPeerList);
  if (st.status === 'connecting') { if (lastPeerList.length) beginSyncing(); else setStatus('online'); }
  if (added.length) { // pesan baru dari jalur Redis -> dorong juga ke peer (mempercepat mesh)
    bump();
    for (const m of added) broadcast(m);
    gapFill(prevMax);
  }
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

/* status "syncing" hanya tampilan; pertukaran riwayat tetap berjalan setelah online */
function beginSyncing() {
  setStatus('syncing');
  st.sync = { done: msgsArr.length, total: msgsArr.length, peers: 0 };
  syncStart = Date.now();
  stopWatchdogs();
  watchT = setInterval(() => {
    if (st.status !== 'syncing') return stopWatchdogs();
    if (Date.now() - syncStart > SYNC_MS) return setStatus('online');
    if (reqOut === 0 && connecting() === 0 && Date.now() - syncStart > 4000) setStatus('online');
  }, 2000);
  syncT = setTimeout(() => { if (st.status === 'syncing') setStatus('online'); }, SYNC_MS + 500);
  touch();
}
function stopWatchdogs() { clearInterval(watchT); clearTimeout(syncT); }
const connecting = () => { let n = 0; for (const p of peers.values()) if (!p.open) n++; return n; };

// Redis hanya menyimpan 10 pesan terbaru -> antara dua polling bisa ada yang terlewat; minta celah itu ke peer.
function gapFill(prevMax) {
  for (const p of peers.values()) if (p.open && !p.reqF && !p.reqB) return ask(p, 'f', { k: 'req', dir: 'f', after: Math.max(0, prevMax - 1), lim: BATCH });
}

/* ---------- mesh WebRTC ---------- */
const peers = new Map(); // pid -> {pid, pc, dc, open, n, seen, reqF, reqB, timer, out, bad}
let reqOut = 0;

const sendFrame = (p, obj) => { if (p.open && p.dc) { try { p.dc.send(JSON.stringify(obj)); } catch { kill(p); } } };
function sig(to, t, d) { bump(); api('/api/gc/signal', { from: meId(), to, t, d }); } // signaling aktif -> polling dipercepat supaya balasan cepat diambil
function ask(p, dir, frame) { // satu permintaan berjalan per arah per peer (dihitung supaya fase syncing tahu kapan selesai)
  if (dir === 'b') { if (p.reqB) return; p.reqB = true; } else { if (p.reqF) return; p.reqF = true; }
  reqOut++;
  sendFrame(p, frame);
}

function maintainMesh(list) {
  const now = Date.now();
  for (const p of peers.values()) if (list.includes(p.pid)) p.seen = now;
  for (const p of [...peers.values()]) if (now - p.seen > 100000) kill(p); // hilang dari presence -> putuskan
  if (document.hidden || !alive) return;
  let active = peers.size;
  for (const pid of list) {
    if (active >= PEERS_MAX) break;
    if (pid === meId() || peers.has(pid) || (cool.get(pid) || 0) > now) continue;
    if (meId() < pid) { offer(pid); active++; } // aturan anti-bentrok: cid lebih kecil yang menawarkan
  }
}

async function offer(pid) {
  let pc; try { pc = new RTCPeerConnection(ICE); } catch { return; }
  const p = { pid, pc, dc: null, open: false, n: 0, seen: Date.now(), reqF: false, reqB: false, timer: 0, out: true, bad: 0 };
  peers.set(pid, p);
  try { p.dc = pc.createDataChannel('gc', { ordered: true }); } catch { return kill(p); }
  wire(p); // dipasang setelah dc ada supaya handler channel tidak terlewat
  try {
    const o = await pc.createOffer();
    await pc.setLocalDescription(o);
    sig(pid, 'o', o.sdp);
  } catch { return kill(p); }
  p.timer = setTimeout(() => kill(p), CONNECT_MS);
}

async function answer(pid, sdp) {
  let pc; try { pc = new RTCPeerConnection(ICE); } catch { return; }
  const p = { pid, pc, dc: null, open: false, n: 0, seen: Date.now(), reqF: false, reqB: false, timer: 0, out: false, bad: 0 };
  peers.set(pid, p);
  wire(p);
  pc.ondatachannel = e => { p.dc = e.channel; wireChannel(p); };
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp });
    const a = await pc.createAnswer();
    await pc.setLocalDescription(a);
    sig(pid, 'a', a.sdp);
  } catch { return kill(p); }
  p.timer = setTimeout(() => kill(p), CONNECT_MS);
}

function wire(p) {
  p.pc.onicecandidate = e => { if (e.candidate) sig(p.pid, 'i', e.candidate.toJSON()); };
  p.pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(p.pc.connectionState)) kill(p); };
  if (p.dc) wireChannel(p);
}
function wireChannel(p) {
  p.dc.onopen = () => {
    clearTimeout(p.timer); p.open = true; p.out = false;
    sendFrame(p, { k: 'hi', v: 1, n: msgsArr.length, wm, tombs: [...tombs].slice(-500) });
    wantHistory(p);
    if (st.sync) { st.sync = { ...st.sync, peers: openPeers() }; touch(); }
  };
  p.dc.onmessage = e => onFrame(p, e.data);
  p.dc.onclose = () => kill(p);
  p.dc.onerror = () => kill(p);
}
const openPeers = () => { let n = 0; for (const p of peers.values()) if (p.open) n++; return n; };

function kill(p, graceful) {
  if (!peers.get(p.pid)) return;
  peers.delete(p.pid);
  clearTimeout(p.timer);
  if (p.reqF || p.reqB) reqOut = Math.max(0, reqOut - 1); // permintaannya tak akan dijawab
  try { p.dc && p.dc.close(); } catch {}
  try { p.pc.close(); } catch {}
  // Cooldown menyesuaikan penyebabnya: putus sopan (bye) tanpa jeda; koneksi yang sempat jalan lalu hilang
  // (mis. pengguna reload halaman) jeda pendek; handshake yang tak pernah terbuka (peer hantu/gagal) jeda panjang.
  if (!graceful) cool.set(p.pid, Date.now() + (p.open ? 10000 : 60000));
  if (st.sync) { st.sync = { ...st.sync, peers: openPeers() }; touch(); }
}

function onSignal(s) {
  if (!s || typeof s.f !== 'string' || s.f === meId() || !CID_RE.test(s.f)) return;
  const p = peers.get(s.f);
  if (s.t === 'o') {
    if (p && p.out) return;          // bentrok: aku pihak penawar -> abaikan tawaran mereka
    if (!p && peers.size >= PEERS_MAX + 2) return;
    if (typeof s.d === 'string' && s.d.length < 3600) answer(s.f, s.d);
  } else if (p) {
    if (s.t === 'a' && typeof s.d === 'string') p.pc.setRemoteDescription({ type: 'answer', sdp: s.d }).catch(() => kill(p));
    else if (s.t === 'i' && s.d && typeof s.d === 'object') p.pc.addIceCandidate(s.d).catch(() => {});
  }
}

/* ---------- protokol pertukaran di atas DataChannel ---------- */
function bad(p) { if (++p.bad > 10) kill(p); } // peer mengirim sampah -> putuskan

async function onFrame(p, raw) {
  if (typeof raw !== 'string' || raw.length > FRAME_MAX) return bad(p);
  let f; try { f = JSON.parse(raw); } catch { return bad(p); }
  if (!f || typeof f.k !== 'string') return bad(p);
  switch (f.k) {
    case 'hi':
      p.n = Math.max(0, f.n | 0);
      applyTombs(Array.isArray(f.tombs) ? f.tombs : [], f.wm);
      if (st.sync) st.sync = { done: Math.min(msgsArr.length, Math.max(st.sync.total, p.n)), total: Math.max(st.sync.total, p.n), peers: openPeers() };
      wantHistory(p);
      touch();
      break;
    case 'req': serveReq(p, f); break;
    case 'msgs': onMsgs(p, f); break;
    case 'msg': {
      if (!okShape(f.m)) return bad(p);
      const added = await ingest([f.m], true);
      if (added.length) { bump(); relay(p, f); }
      break;
    }
    case 'tomb':
      if (applyTombs(Array.isArray(f.ids) ? f.ids : [], f.wm)) relay(p, f);
      break;
    case 'bye': kill(p, true); break;
  }
}

function wantHistory(p) {
  if (!p.open) return;
  if (p.n > msgsArr.length) ask(p, 'f', { k: 'req', dir: 'f', after: Math.max(0, (msgsArr[msgsArr.length - 1]?.ts || 0) - 1), lim: BATCH });
  const myMin = msgsArr[0]?.ts || 0;
  if (myMin) ask(p, 'b', { k: 'req', dir: 'b', before: myMin, lim: BATCH }); // isi ke belakang (riwayat lama)
}

function serveReq(p, f) {
  const lim = Math.min(BATCH * 2, Math.max(1, f.lim | 0 || BATCH));
  let list = [], more = false;
  if (f.dir === 'b' && Number.isInteger(f.before)) {
    const older = msgsArr.filter(m => m.ts < f.before);
    list = older.slice(-lim); more = older.length > lim; // yang terdekat dengan batas, tetap dikirim urut naik
  } else {
    const newer = msgsArr.filter(m => m.ts > Math.max(0, Number(f.after) || 0));
    list = newer.slice(0, lim); more = newer.length > lim;
  }
  sendFrame(p, { k: 'msgs', dir: f.dir === 'b' ? 'b' : 'f', list, more });
}

async function onMsgs(p, f) {
  if (!Array.isArray(f.list) || f.list.length > BATCH * 2) return bad(p);
  const back = f.dir === 'b';
  if (back) { p.reqB = false; } else { p.reqF = false; }
  reqOut = Math.max(0, reqOut - 1);
  const added = await ingest(f.list, true);
  // lanjut halaman berikutnya hanya kalau halaman ini benar-benar menambah (mencegah loop untuk data duplikat)
  if (f.more && added.length) {
    const after = Math.max(0, (msgsArr[msgsArr.length - 1]?.ts || 0) - 1), before = msgsArr[0]?.ts || 0;
    ask(p, back ? 'b' : 'f', back ? { k: 'req', dir: 'b', before, lim: BATCH } : { k: 'req', dir: 'f', after, lim: BATCH });
  } else if (st.sync) {
    st.sync = { ...st.sync, done: Math.min(msgsArr.length, st.sync.total), peers: openPeers() };
    if (reqOut === 0 && connecting() === 0 && Date.now() - syncStart > 4000) setStatus('online');
    touch();
  }
}

function relay(exclude, f) {
  const h = (f.h || 1) + 1;
  if (h > HOPS) return;
  for (const p of peers.values()) if (p.open && p !== exclude) sendFrame(p, { ...f, h });
}
function broadcast(m) { for (const p of peers.values()) if (p.open) sendFrame(p, { k: 'msg', m, h: 1 }); }
function broadcastTomb(list, wmv) { for (const p of peers.values()) if (p.open) sendFrame(p, { k: 'tomb', ids: list, wm: wmv }); }
function byeAll() { for (const p of peers.values()) if (p.open) { try { p.dc.send('{"k":"bye"}'); } catch {} } for (const p of [...peers.values()]) kill(p, true); }

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
  idbDel([id]); persistMeta(); broadcastTomb([id], wm); touch();
}

async function clearAll() {
  const code = askCode(); if (!code) return;
  const snap = msgsArr;
  msgsArr = []; ids.clear(); touch();
  const r = await api('/api/gc/delete', { code, all: 1 });
  if (!r.ok || !r.json?.ok) { msgsArr = snap; for (const m of snap) ids.add(m.id); return touch(); }
  devCode = code;
  wm = Math.max(wm, r.json.wm || 0);
  idbDel(snap.map(m => m.id)); persistMeta(); broadcastTomb([], wm); touch();
}

/* ---------- kirim pesan ---------- */
const canSend = () => st.status === 'online' || st.status === 'syncing';
function failTmp(m, why) { const p = pending.find(x => x.id === m.id); if (!p) return; p.status = 'failed'; p.err = why || 'Gagal terkirim'; touch(); }
function dropTmp(m) { pending = pending.filter(x => x.id !== m.id); touch(); }

function send(text) {
  if (!canSend() || typeof text !== 'string' || !text.trim()) return null;
  const s = getSelf();
  const tmp = { id: 'tmp-' + uid(), senderId: s.id, senderName: s.name, text, ts: Date.now(), status: 'sending' };
  pending.push(tmp); touch(); bump();
  deliver(text, tmp);
  return tmp;
}
async function deliver(text, tmp) {
  const t = setTimeout(() => { if (pending.some(x => x.id === tmp.id && x.status === 'sending')) failTmp(tmp); }, 15000);
  const r = await api('/api/gc/send', { clientId: meId(), name: getSelf().name, text });
  clearTimeout(t);
  if (!pending.some(x => x.id === tmp.id)) return; // sudah dibersihkan (mis. dicoba ulang)
  if (r.ok && r.json?.m) {
    dropTmp(tmp);
    const added = await ingest([r.json.m], false);
    if (added.length) broadcast(r.json.m); // dorong ke peer secara realtime
  } else failTmp(tmp, r.json?.error);
}

function retry(id) {
  const m = pending.find(x => x.id === id);
  if (!m || m.status !== 'failed' || !canSend()) return;
  m.status = 'sending'; touch(); bump();
  deliver(m.text, m);
}

/* ---------- siklus hidup ---------- */
function sleep() { if (!booted) return; sleeping = true; alive = false; clearTimeout(beatT); stopWatchdogs(); byeAll(); setStatus('offline', null); }
function wake() { if (!booted) return; sleeping = false; alive = true; failN = 0; if (st.status !== 'online') setStatus('connecting'); beat(); }

let life = false;
function setupLifecycle() {
  if (life) return; life = true;
  const gcEl = document.getElementById('gc');
  if (gcEl) {
    let sleepT = 0;
    new MutationObserver(() => {
      if (gcEl.classList.contains('show')) { clearTimeout(sleepT); if (sleeping || !alive) wake(); }
      else sleepT = setTimeout(sleep, IDLE_SLEEP); // buka-tutup cepat tidak memutus koneksi
    }).observe(gcEl, { attributes: true, attributeFilter: ['class'] });
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && alive) { clearTimeout(beatT); beat(); } });
  window.addEventListener('pagehide', () => { flush(); byeAll(); });
}

/* ---------- adapter (kontrak UI) ---------- */
const A = window.GlobalChatAdapter = {
  setSelf(fn) { if (typeof fn === 'function') getSelf = fn; },
  getState: () => st,
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  async connect() { // dipanggil sekali saat UI pertama dibuka
    if (booted) return; booted = true;
    setupLifecycle();
    setStatus('connecting');
    await initStore(); // riwayat lokal tampil dulu, baru disinkronkan
    touch();
    alive = true; delay = POLL.burst;
    beat();
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
  deleteMessage,
  clearAll,
  debug: () => ({ status: st.status, msgs: msgsArr.length, pending: pending.length, peers: [...peers.keys()], open: openPeers(), tombs: tombs.size, wm, tombTs, poll: POLL, alive })
};
})();
