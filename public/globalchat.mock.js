/* ===== Chat Global: adapter MOCK (data contoh, state lokal di memori) =====
   Tidak ada jaringan, API, Redis, WebRTC, atau sinkronisasi sungguhan di sini.
   Nanti file ini diganti adapter sungguhan yang memberi bentuk yang sama, tanpa mengubah globalchat.js (UI).

   Bentuk state yang dibaca UI (view model UI, BUKAN kontrak API):
     { status: 'connecting' | 'syncing' | 'online' | 'offline',
       error: string | null,                      // alasan kalau offline karena gagal terhubung
       onlineCount: number | null,                // opsional
       sync: { done, total, peers } | null,       // hanya saat status 'syncing'
       rev: number,                               // naik setiap daftar pesan berubah
       messages: [{ id, senderId, senderName, text, ts, status: 'sending' | 'sent' | 'failed' }] }  // urut lama -> baru

   Fungsi yang dipanggil UI:
     setSelf(fn)  fn() -> { id, name }            connect()   reconnect()
     getState()   subscribe(fn) -> unsubscribe    send(text) -> pesan   retry(id)
     deleteMessage(id)   clearAll()
   Khusus simulasi (cuma ada di mock, dipakai panel Dev): A.dev = { setStatus, failNext, failConnect, incoming, reseed, flags } */
(() => {
'use strict';

const MAXMSG = 200;
let getSelf = () => ({ id: 'self', name: 'Tamu' });
const uid = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = a => a[Math.floor(Math.random() * a.length)];

const PEOPLE = {
  sakura: ['u-sakura', 'Sakura'], bima: ['u-bima', 'Bima'], nadia: ['u-nadia', 'Nadia'],
  rendra: ['u-rendra', 'Rendra'], luna: ['u-luna', 'Luna'], farel: ['u-farel', 'Farel']
};
const INCOMING = [
  'Ada yang online? Lagi pengen ngobrol santai nih.',
  'Barusan nyoba voice note bahasa Jepang, ternyata seru juga.',
  'Selamat siang semuanya!',
  'Ada yang tau cara ekspor obrolan ke file? Lupa lewat menu mana.',
  'Di header chat ada tombol unduhnya, obrolannya jadi file .txt (atau .zip kalau ada voice note).',
  'Makasih infonya, langsung aku coba.',
  'Kalian biasanya ngobrol sama karakter yang mana?',
  'Hari ini hujan terus, enaknya rebahan sambil chat.'
];

const MIN = 60000;
const mkMsg = (who, text, ago, mine) => {
  const s = mine ? getSelf() : null, p = PEOPLE[who];
  return { id: uid(), senderId: mine ? s.id : p[0], senderName: mine ? s.name : p[1], text, ts: Date.now() - ago * MIN, status: 'sent' };
};
const seed = () => [
  mkMsg('bima', 'Selamat malam semuanya, ada yang masih bangun?', 27 * 60 + 8),
  mkMsg('nadia', 'Masih dong, lagi nonton ulang anime favorit.', 27 * 60 + 6),
  mkMsg('bima', 'Rekomendasiin dong, yang santai aja.', 27 * 60 + 5),
  mkMsg('nadia', 'Coba Frieren, pelan tapi bikin nagih.', 27 * 60 + 3),
  mkMsg('luna', 'Ada yang udah coba voice note Furina? Suaranya enak banget.', 95),
  mkMsg('rendra', 'Udah, pakai suara Jepang. Subtitle-nya ngebantu banget buat nangkep artinya.', 92),
  mkMsg('rendra', 'Buat yang baru: riwayat chat disimpan di perangkat masing-masing, jadi kalau ganti HP masuk aja pakai akun yang sama biar obrolannya nggak hilang begitu aja.', 91),
  mkMsg('luna', 'Noted, nanti aku coba bahasa Jepang juga.', 88),
  mkMsg('farel', 'Tips: nama kamu bisa diganti di menu utama, biar sapaannya lebih personal.', 40),
  mkMsg(null, 'Makasih infonya, baru tau!', 22, true),
  mkMsg('sakura', 'Halo semua, baru gabung. Salam kenal ya!', 18),
  mkMsg('bima', 'Salam kenal, Sakura. Selamat datang!', 12)
];

const st = { status: 'offline', error: null, onlineCount: null, sync: null, rev: 0, messages: [] };
const subs = new Set();
const emit = () => subs.forEach(f => f(st));
const touch = () => { st.rev++; if (st.messages.length > MAXMSG) st.messages = st.messages.slice(-MAXMSG); emit(); };

const timers = new Set();
const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
const clearTimers = () => { timers.forEach(t => { clearTimeout(t); clearInterval(t); }); timers.clear(); };

let started = false, failNextSend = false, failConnect = false;

function startSync() {
  st.status = 'syncing'; st.error = null; st.sync = { done: 0, total: 120, peers: 3 }; emit();
  const iv = setInterval(() => {
    const d = Math.min(st.sync.total, st.sync.done + rnd(10, 24));
    st.sync = { ...st.sync, done: d };
    if (d >= st.sync.total) { clearInterval(iv); timers.delete(iv); st.status = 'online'; st.sync = null; st.onlineCount = 12; }
    emit();
  }, 320);
  timers.add(iv);
}

function reconnect() {
  clearTimers();
  st.status = 'connecting'; st.error = null; st.sync = null; st.onlineCount = null; emit();
  later(() => {
    if (failConnect) { st.status = 'offline'; st.error = 'Gagal terhubung ke chat global'; emit(); }
    else startSync();
  }, 1300);
}

function settle(m, ok) { setTimeout(() => { if (!st.messages.includes(m)) return; m.status = ok ? 'sent' : 'failed'; touch(); }, rnd(700, 1300)); }

const A = window.GlobalChatAdapter = {
  setSelf(fn) { getSelf = fn; },
  getState: () => st,
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  connect() { if (started) return; started = true; st.messages = seed(); st.rev++; reconnect(); }, /* dipanggil sekali waktu UI pertama dibuka */
  reconnect,
  send(text) {
    const s = getSelf(), m = { id: uid(), senderId: s.id, senderName: s.name, text, ts: Date.now(), status: 'sending' };
    st.messages = [...st.messages, m]; touch();
    const fail = failNextSend; failNextSend = false;
    settle(m, !fail);
    return m;
  },
  retry(id) {
    const m = st.messages.find(x => x.id === id); if (!m || m.status !== 'failed') return;
    m.status = 'sending'; touch(); settle(m, true);
  },
  deleteMessage(id) { st.messages = st.messages.filter(x => x.id !== id); touch(); },
  clearAll() { st.messages = []; touch(); }
};

/* hanya untuk panel Dev: mengatur skenario tampilan */
A.dev = {
  flags: () => ({ failNext: failNextSend, failConnect }),
  failNext(v) { failNextSend = !!v; },
  failConnect(v) { failConnect = !!v; },
  setStatus(s) { /* menahan status supaya tampilannya bisa diperiksa */
    clearTimers();
    st.status = s; st.error = null;
    st.sync = s === 'syncing' ? { done: 48, total: 120, peers: 3 } : null;
    st.onlineCount = s === 'online' ? 12 : null;
    emit();
  },
  incoming() {
    const p = PEOPLE[pick(Object.keys(PEOPLE))];
    st.messages = [...st.messages, { id: uid(), senderId: p[0], senderName: p[1], text: pick(INCOMING), ts: Date.now(), status: 'sent' }]; touch();
  },
  reseed() { st.messages = seed(); st.status = 'online'; st.error = null; st.sync = null; st.onlineCount = 12; clearTimers(); touch(); }
};
})();
