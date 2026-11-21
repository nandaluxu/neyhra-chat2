/* ===== Suara Catur (WebAudio, tanpa file audio, tanpa dependency) — dipakai games.js (vs AI) dan chessmp.js (Multiplayer) =====
   Semua bunyi disintesis di browser: langkah (ketukan kayu), tangkapan (lebih berat + dua ketukan), rokade (dua ketukan),
   skak (ping tinggi), promosi (arpeggio naik), mulai game, menang/kalah/seri, dan sting rating Live Move Analysis
   (Brilliant = kilau, Blunder = nada turun; rating lain senyap supaya tidak ramai).
   Aman dipanggil kapan saja: tanpa AudioContext / suara dimatikan / autoplay diblokir => diam, tidak pernah melempar error.
   Toggle disimpan di localStorage (`chsfx`, '0' = mati; default nyala) — pola sama dengan Word Search (`wsSound`).
   API (window.CHSFX): on(), setOn(bool), toggle(), kind(papanSebelum, dari, ke, promo), move(kind), check(), start(), end('win'|'lose'|'draw'), rating(kunci), btn(), icon(on) */
(() => {
'use strict';
const KEY = 'chsfx';
let enabled = true, ac = null, out = null, dst = null, noise = null, lastAt = 0;
try { enabled = localStorage.getItem(KEY) !== '0'; } catch { /* penyimpanan diblokir: tetap nyala */ }

function ctx() {
  if (!enabled) return null;
  try {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
      ac = new AC();
      // kompresor di ujung: beberapa bunyi bersamaan (tangkapan + skak) tidak pecah/clipping
      const comp = ac.createDynamicsCompressor(); comp.threshold.value = -10; comp.ratio.value = 5;
      out = ac.createGain(); out.gain.value = 1.0; out.connect(comp); comp.connect(ac.destination);
      noise = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.25), ac.sampleRate);
      const d = noise.getChannelData(0); let x = 0x2545f491; for (let i = 0; i < d.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; d[i] = (x | 0) / 2147483648; }   // noise tetap (bukan random): level & karakter ketukan selalu sama
    }
    if (ac.state === 'suspended') ac.resume().catch(() => { });
    return ac;
  } catch { return null; }
}
const env = (g, t, peak, dur, attack) => {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + (attack || 0.004));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
};
/* ketukan bidak di papan kayu: letupan noise ber-bandpass (klik) + debam sinus yang turun (badan kayu) */
function tap(a, t, { vol = 1, freq = 1400, q = 1.1, dur = 0.06, low = 170, body = 0.5 } = {}) {
  const n = a.createBufferSource(); n.buffer = noise;
  const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
  const g = a.createGain(); env(g, t, 1.5 * vol, dur, 0.002);
  n.connect(bp); bp.connect(g); g.connect(dst); n.start(t); n.stop(t + dur + 0.02);
  const o = a.createOscillator(), og = a.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(low, t); o.frequency.exponentialRampToValueAtTime(low * 0.5, t + 0.09);
  env(og, t, 1.3 * body * vol, 0.11, 0.003);
  o.connect(og); og.connect(dst); o.start(t); o.stop(t + 0.14);
}
function note(a, t, f, d, { vol = 0.12, type = 'sine', h3 = 0 } = {}) {
  vol *= 2.2;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.value = f; env(g, t, vol, d, 0.012);
  o.connect(g); g.connect(dst); o.start(t); o.stop(t + d + 0.03);
  if (h3) { const o2 = a.createOscillator(), g2 = a.createGain(); o2.type = 'sine'; o2.frequency.value = f * 3; env(g2, t, vol * h3, d * 0.7, 0.01); o2.connect(g2); g2.connect(dst); o2.start(t); o2.stop(t + d + 0.03); }
}
/* tingkat tiap bunyi dikalibrasi supaya terdengar setara (puncak sekitar 0,3–0,45 setelah kompresor): respons filter pada noise tetap berbeda per frekuensi */
const LEVEL = { move: 2.0, capture: 1.3, castle: 0.6, promo: 1.4, check: 2.3, start: 1.65, win: 1.45, lose: 1.35, draw: 1.65, brilliant: 1.65, blunder: 3.3 };
const run = name => { const a = ctx(); if (!a) return; try { dst = a.createGain(); dst.gain.value = LEVEL[name] || 1; dst.connect(out); S[name](a, a.currentTime + 0.005); } catch { /* bunyi gagal tidak boleh mengganggu permainan */ } };

const S = {
  move: (a, t) => tap(a, t, { freq: 1500, dur: 0.05, low: 190, body: 0.45 }),
  capture: (a, t) => { tap(a, t, { vol: 1.25, freq: 950, q: 0.9, dur: 0.085, low: 130, body: 0.65 }); tap(a, t + 0.05, { vol: 0.7, freq: 1300, dur: 0.05, low: 170, body: 0.35 }); },
  castle: (a, t) => { tap(a, t, { freq: 1350, dur: 0.055, low: 160 }); tap(a, t + 0.11, { freq: 1550, dur: 0.05, low: 190 }); },
  promo: (a, t) => { tap(a, t, { freq: 1500, dur: 0.05 }); [523, 659, 784, 1047].forEach((f, i) => note(a, t + 0.09 + i * 0.07, f, 0.16, { vol: 0.1, h3: 0.2 })); },
  check: (a, t) => { note(a, t, 1318, 0.2, { vol: 0.1, h3: 0.15 }); note(a, t + 0.07, 1760, 0.22, { vol: 0.07 }); },
  start: (a, t) => { note(a, t, 392, 0.16, { vol: 0.09 }); note(a, t + 0.13, 523, 0.26, { vol: 0.1, h3: 0.15 }); },
  win: (a, t) => { [523, 659, 784].forEach((f, i) => note(a, t + i * 0.11, f, 0.2, { vol: 0.11, h3: 0.2 })); note(a, t + 0.36, 1047, 0.55, { vol: 0.12, h3: 0.25 }); },
  lose: (a, t) => { [392, 330, 262].forEach((f, i) => note(a, t + i * 0.2, f, 0.3, { vol: 0.1, type: 'triangle' })); },
  draw: (a, t) => { note(a, t, 440, 0.2, { vol: 0.09 }); note(a, t + 0.18, 440, 0.32, { vol: 0.08, type: 'triangle' }); },
  brilliant: (a, t) => { [784, 988, 1319, 1760].forEach((f, i) => note(a, t + i * 0.065, f, i === 3 ? 0.5 : 0.18, { vol: 0.085, h3: 0.25 })); },
  blunder: (a, t) => {
    const o = a.createOscillator(), g = a.createGain(), lp = a.createBiquadFilter();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(233, t); o.frequency.exponentialRampToValueAtTime(98, t + 0.32);
    lp.type = 'lowpass'; lp.frequency.value = 1200; env(g, t, 0.3, 0.36, 0.01);
    o.connect(lp); lp.connect(g); g.connect(dst); o.start(t); o.stop(t + 0.4);
  }
};
/* jenis langkah dari papan SEBELUM langkah (string 64: huruf besar putih, kecil hitam, '.' kosong): move | capture | castle | promo */
function kind(old, f, t) {
  const p = String(old[f] || '').toLowerCase();
  if (p === 'k' && Math.abs(t - f) === 2) return 'castle';
  if (p === 'p' && ((t >> 3) === 0 || (t >> 3) === 7)) return 'promo';
  if (old[t] !== '.' || (p === 'p' && (f & 7) !== (t & 7))) return 'capture';   // diagonal pion ke kotak kosong = en passant
  return 'move';
}
const ICON = {
  on: '<svg viewBox="0 0 24 24" aria-hidden="true" style="fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round"><path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M15.5 9a4 4 0 010 6M18 6.8a7.2 7.2 0 010 10.4"/></svg>',
  off: '<svg viewBox="0 0 24 24" aria-hidden="true" style="fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round"><path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>'
};

window.CHSFX = {
  on: () => enabled,
  setOn(v) { enabled = !!v; try { localStorage.setItem(KEY, enabled ? '1' : '0'); } catch { } if (enabled) run('move'); },   // bunyi contoh saat dinyalakan (sekaligus membuka AudioContext lewat gestur pengguna)
  toggle() { this.setOn(!enabled); return enabled; },
  kind,
  move(k) { const now = performance.now(); if (now - lastAt < 25) return; lastAt = now; run(S[k] ? k : 'move'); },
  check: () => run('check'),
  start: () => run('start'),
  end: r => run(S[r] ? r : 'draw'),
  rating: k => { if (k === 'brilliant' || k === 'blunder') run(k); },
  icon: on => (on === false ? ICON.off : ICON.on),
  /* tombol toggle siap pasang; `attr` = atribut aksi milik layar pemanggil (data-act="csnd" / data-cm="snd") */
  btn: attr => '<button class="gm-ghost cm-flip" type="button" ' + attr + ' aria-pressed="' + enabled + '" aria-label="' + (enabled ? 'Matikan suara' : 'Nyalakan suara') + '">' + (enabled ? ICON.on : ICON.off) + '</button>'
};
})();
