/* ===== TurnPipe: pipeline giliran asinkron untuk chat grup dan telepon grup =====
   Dimuat sebelum group.js dan call.js (lihat index.html). Tidak menyentuh DOM, jadi bisa diuji di Node (scripts/turnpipe-test.mjs).

   Tiga tahap, masing-masing jalan di "jalurnya" sendiri supaya tidak saling memblokir:

     1. THINK   (LLM)     Berurutan, SATU anggota pada satu waktu. Tiap anggota membaca konteks bersama yang LENGKAP:
                          semua pesan yang sudah tampil + semua balasan yang sudah jadi tapi belum diputar (ledger).
                          Begitu teks anggota selesai, ia langsung masuk ledger dan anggota berikutnya boleh mulai mikir.
                          Tahap ini TIDAK menunggu TTS maupun pemutaran audio anggota sebelumnya.
     2. PREPARE (TTS)     Dimulai detik itu juga ketika teks selesai (Fish Audio lewat /api/tts), paralel dengan THINK anggota
                          berikutnya dan paralel dengan pemutaran audio anggota sebelumnya. Audio boleh jadi lebih dulu.
     3. PRESENT (tampil + putar)
                          Antrean FIFO ketat: giliran N baru tampil/diputar setelah giliran N-1 SELESAI diputar, dan setelah
                          audio N sendiri siap. Tidak mungkin ada giliran yang menyalip, walau TTS giliran N lebih cepat selesai.

   Kegagalan satu giliran (TTS gagal, tampilan error) tidak pernah memutus antrean: setiap mata rantai menangkap galatnya sendiri. */
(() => {
'use strict';
const root = typeof window !== 'undefined' ? window : globalThis;

const abortErr = () => { const e = new Error('Dibatalkan'); e.name = 'AbortError'; e.aborted = true; return e; };

// promise yang selesai (true) saat signal dibatalkan; tidak pernah selesai kalau tidak ada signal
const whenAborted = signal => new Promise(res => {
  if (!signal) return;
  if (signal.aborted) return res(true);
  signal.addEventListener('abort', () => res(true), { once: true });
});

/* AbortSignal turunan: batal kalau signal induk batal ATAU lewat `ms`. Dipakai fetch supaya request yang menggantung tidak
   menahan antrean. `timedOut()` membedakan "kelamaan" dari "dibatalkan sengaja". Panggil clear() di finally. */
function timeout(signal, ms) {
  const ctl = new AbortController(); let timedOut = false;
  const onAbort = () => ctl.abort();
  if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  const tm = ms > 0 ? setTimeout(() => { timedOut = true; ctl.abort(); }, ms) : 0;
  return { signal: ctl.signal, timedOut: () => timedOut, clear() { clearTimeout(tm); if (signal) signal.removeEventListener('abort', onAbort); } };
}

/* create({ signal, maxAhead, after }) -> pipeline untuk SATU rantai percakapan.
   - signal   : AbortSignal rantai. Batal = giliran yang belum tampil dilewati (turn.skip dipanggil), yang sedang diputar dibiarkan selesai.
   - maxAhead : maks giliran yang sudah dibuat tapi belum selesai diputar (termasuk yang sedang diputar). Menahan THINK supaya
                kalau user menyela, LLM/TTS yang terbuang tidak banyak.
   - after    : promise pemutaran rantai sebelumnya; giliran pertama menunggunya (voice note yang sedang jalan tidak ditimpa).
                Hasil `false` (user menjeda) diubah jadi `true`: rantai baru tetap boleh putar otomatis. */
function create({ signal, maxAhead = 3, after } = {}) {
  const abortP = whenAborted(signal);
  const aborted = () => !!(signal && signal.aborted);
  const ledger = [];            // konteks bersama rantai ini: { from, text } berurutan, ditambah SEBELUM tahap TTS dimulai
  let queued = 0, waiters = [];
  let tail = Promise.resolve(after).then(v => v === false ? true : v, () => undefined);

  const wake = () => { if (queued < maxAhead || aborted()) { const w = waiters; waiters = []; w.forEach(f => f()); } };
  if (signal) signal.addEventListener('abort', wake, { once: true });

  /* turn = { from, text, prepare(signal) -> Promise<any>, present(prep, prev) -> Promise<any>, skip() }
     prep = { ok:true, v } atau { ok:false, e } (prepare tidak pernah membuat antrean gagal). prev = hasil present giliran sebelumnya. */
  function add(turn) {
    ledger.push({ from: turn.from, text: turn.text }); // 1) teks masuk konteks bersama SEKARANG
    queued++;
    const prepared = Promise.resolve()                 // 2) TTS (atau penyiapan lain) mulai SEKARANG, tanpa menunggu giliran
      .then(() => turn.prepare ? turn.prepare(signal) : null)
      .then(v => ({ ok: true, v }), e => ({ ok: false, e }));
    const done = tail.then(async prev => {             // 3) tampil + putar: hanya setelah mata rantai sebelumnya selesai
      try {
        if (aborted()) { await skip(turn); return prev; }
        const prep = await Promise.race([prepared, abortP]); // audio sendiri harus siap; batal di tengah = lewati
        if (prep === true || aborted()) { await skip(turn); return prev; }
        return await turn.present(prep, prev);
      } catch (e) { console.warn('[turnpipe]', e); return prev; }
      finally { queued--; wake(); }
    });
    tail = done;
    return { prepared, done };
  }
  async function skip(turn) { try { if (turn.skip) await turn.skip(); } catch {} }

  return {
    add,
    // resolve kalau masih ada ruang untuk giliran baru (atau rantai dibatalkan)
    room() { return aborted() || queued < maxAhead ? Promise.resolve() : new Promise(res => waiters.push(res)); },
    // resolve setelah SEMUA giliran yang sudah ditambahkan selesai diputar (termasuk yang ditambahkan selagi menunggu)
    async idle() { let t; do { t = tail; await t; } while (t !== tail); },
    last: () => tail,
    pending: () => queued,
    context: () => ledger.slice(),
    aborted
  };
}

/* drive(opts): pemandu rantai giliran (dipakai chat grup dan telepon grup, jadi aturannya identik).
   Satu anggota berpikir pada satu waktu; teksnya masuk pipeline (TTS langsung jalan) lalu anggota berikutnya LANGSUNG mulai
   berpikir dengan konteks yang sudah memuat balasan itu. Tidak menunggu audio.
     pipe, signal, first[] (yang disebut user, berurutan, tidak kena peluang), max (maks balasan), maxPerChar,
     accept(depth) -> peluang menerima usulan <next>, canSpeak(id),
     think(sp, ctx) -> Promise<{ text, next, ... } | null>   ctx = { depth, replyTo, history, queued, counts }; null = hentikan rantai
     turn(sp, r, ctx) -> turn untuk pipe.add */
async function drive(o) {
  const { pipe, signal } = o, queue = [...(o.first || [])], counts = {}, abortP = whenAborted(signal);
  let depth = 0, nextId = null, replyTo = null;
  while (depth < o.max && !signal.aborted) {
    let sp;
    if (queue.length) { sp = queue.shift(); replyTo = null; } // yang disebut user: berurutan, tidak kena peluang accept
    else if (nextId) { sp = nextId; nextId = null; }
    else break;
    if (o.canSpeak && !o.canSpeak(sp)) continue;
    await pipe.room();                                         // batas "maju duluan": tidak menumpuk giliran yang belum terputar
    if (signal.aborted) break;
    const r = await o.think(sp, { depth, replyTo, history: pipe.context(), queued: queue.length, counts });
    if (!r || signal.aborted) break;
    pipe.add(o.turn(sp, r, { depth, replyTo }));               // teks masuk konteks bersama + TTS mulai
    depth++; counts[sp] = (counts[sp] || 0) + 1;
    if (queue.length) continue;
    const nx = r.next;
    const ok = nx && (!o.canSpeak || o.canSpeak(nx)) && (counts[nx] || 0) < (o.maxPerChar ?? 2) && depth < o.max && Math.random() < (o.accept ? o.accept(depth) : 0);
    if (!ok) break;
    nextId = nx; replyTo = { from: sp, text: r.text };
  }
  await Promise.race([pipe.idle(), abortP]);                   // tunggu giliran terakhir selesai diputar (atau dibatalkan)
}

root.TurnPipe = { create, drive, timeout, whenAborted, abortErr };
})();
