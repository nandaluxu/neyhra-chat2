/* ===== Extras: (1) tema + warna aksen per karakter, (2) cari isi semua obrolan, (3) ringkasan harian =====
   Dimuat paling akhir. Memakai global index.html: $, store, allChars, loadLog, openChat, ch, ready, chat, app, q, rows,
   closeSettings, uname, dayLabel, now, saveBlob. Semua data tetap di perangkat (localStorage), tidak ada request baru. */
(() => {
'use strict';
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const DAY = 864e5;
const charById = id => allChars.find(c => c.id === id);

/* ================= 1. Tema + aksen per karakter ================= */
const root = document.documentElement, cv = $('chatview'), mq = matchMedia('(prefers-color-scheme:dark)');
const metas = [...document.querySelectorAll('meta[name=theme-color]')], metaOrig = metas.map(m => m.content);
let mode = store.get('theme'); if (mode !== 'light' && mode !== 'dark') mode = 'auto';
let accOn = store.get('acc') !== '0', accFor = null;
const isDark = () => mode === 'dark' || (mode === 'auto' && mq.matches);

function paintSeg() { $('seg-th').querySelectorAll('button').forEach(b => b.classList.toggle('sel', b.dataset.v === mode)); }
function applyTheme() {
  if (mode === 'auto') root.removeAttribute('data-theme'); else root.dataset.theme = mode;
  metas.forEach((m, i) => { m.content = mode === 'auto' ? metaOrig[i] : mode === 'dark' ? '#0b0b0c' : '#ffffff'; });
  paintSeg(); if (accFor) applyAccent(accFor);
}
$('seg-th').onclick = e => { const b = e.target.closest('button'); if (!b) return; mode = b.dataset.v; store.set('theme', mode === 'auto' ? null : mode); applyTheme(); };
mq.addEventListener && mq.addEventListener('change', () => { if (mode === 'auto') applyTheme(); });
$('sacc').checked = accOn;
$('sacc').onchange = e => { accOn = e.target.checked; store.set('acc', accOn ? '1' : '0'); if (accFor) applyAccent(accFor); };
applyTheme();

/* Warna khas karakter = rata-rata rona piksel berwarna di fotonya (di-cache di localStorage `ac:<id>`; {n:1} = foto abu-abu, tanpa aksen) */
const memo = new Map();
function hueOf(c) {
  if (memo.has(c.id)) return memo.get(c.id);
  const cached = store.get('ac:' + c.id);
  if (cached) { try { const p = Promise.resolve(JSON.parse(cached)); memo.set(c.id, p); return p; } catch {} }
  const p = new Promise(res => {
    if (!c.avatar) return res(null);
    const im = new Image();
    im.onload = () => {
      try {
        const S = 40, k = document.createElement('canvas'); k.width = k.height = S;
        const g = k.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0, S, S);
        const d = g.getImageData(0, 0, S, S).data; let X = 0, Y = 0, W = 0, SS = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, gg, b), dl = mx - Math.min(r, gg, b);
          if (d[i + 3] < 200 || !dl || mx < .2 || mx > .97) continue;
          const s = dl / mx, w = s * s * mx; if (w < .02) continue;
          let hh = mx === r ? ((gg - b) / dl) % 6 : mx === gg ? (b - r) / dl + 2 : (r - gg) / dl + 4; hh *= Math.PI / 3;
          X += Math.cos(hh) * w; Y += Math.sin(hh) * w; W += w; SS += s * w;
        }
        if (W < 3) return res({ n: 1 });
        res({ h: Math.round((Math.atan2(Y, X) * 180 / Math.PI + 360) % 360), s: Math.round(Math.min(.8, Math.max(.45, SS / W)) * 100) });
      } catch { res(null); }
    };
    im.onerror = () => res(null); im.src = c.avatar;
  });
  memo.set(c.id, p); p.then(v => { if (v) store.set('ac:' + c.id, JSON.stringify(v)); });
  return p;
}
function clearAccent() { ['--me', '--me-ink', '--on'].forEach(k => cv.style.removeProperty(k)); cv.removeAttribute('data-acc'); }
async function applyAccent(c) {
  accFor = c;
  if (!accOn) return clearAccent();
  const v = await hueOf(c); if (accFor !== c) return;
  if (!v || v.n) return clearAccent();
  const dark = isDark(), col = `hsl(${v.h} ${v.s}% ${dark ? 66 : 42}%)`;
  cv.style.setProperty('--me', col); cv.style.setProperty('--me-ink', dark ? '#0b0b0c' : '#fff'); cv.style.setProperty('--on', col); cv.setAttribute('data-acc', '');
}
{ // pasang di openChat (kartu memanggilnya lewat nama global saat diklik, jadi pembungkus ini ikut terpakai)
  const orig = openChat;
  openChat = function (c) { if (c && !c.isGroup) applyAccent(c); return orig.apply(this, arguments); };
}
new MutationObserver(() => { // keluar chat -> aksen dibuang setelah animasi tutup; buka grup (ch = null) -> tanpa aksen
  if (!app.classList.contains('open')) setTimeout(() => { if (!app.classList.contains('open')) { accFor = null; clearAccent(); } }, 800);
  else if (!ch) { accFor = null; clearAccent(); }
}).observe(app, { attributes: true, attributeFilter: ['class'] });

/* ================= 2. Cari isi semua obrolan (panel "Semua karakter") ================= */
const xs = h('div'); xs.id = 'xs'; xs.className = 'hide'; $('alllist').prepend(xs);
q.placeholder = 'Cari nama, judul, atau isi obrolan';
const MAXHIT = 30;
function snippet(text, p, len) {
  const a = Math.max(0, p - 28), b = Math.min(text.length, p + len + 60), box = h('span', 'x-sn');
  if (a) box.append('…');
  box.append(text.slice(a, p)); box.append(Object.assign(h('mark'), { textContent: text.slice(p, p + len) })); box.append(text.slice(p + len, b));
  if (b < text.length) box.append('…');
  return box;
}
function jump(c, i, from) {
  openChat(c, from);
  let n = 0;
  const iv = setInterval(() => {
    if (!ready && ++n < 60) return;
    clearInterval(iv);
    const r = chat.querySelectorAll('.row')[i]; if (!r) return;
    setTimeout(() => { r.scrollIntoView({ block: 'center' }); r.classList.add('xjump'); setTimeout(() => r.classList.remove('xjump'), 2300); }, 150);
  }, 60);
}
function searchAll() {
  const k = q.value.trim().toLowerCase(); xs.textContent = '';
  if ([...k].length < 2) { xs.classList.add('hide'); return; }
  const res = [];
  for (const c of allChars) {
    const l = loadLog(c.id);
    for (let i = 0; i < l.length; i++) {
      const e = l[i];
      for (const t of [e.x, e.jp]) {
        if (typeof t !== 'string') continue;
        const p = t.toLowerCase().indexOf(k); if (p >= 0) { res.push({ c, i, e, t, p }); break; }
      }
    }
  }
  if (!res.length) { xs.classList.add('hide'); return; }
  res.sort((a, b) => (b.e.t || 0) - (a.e.t || 0));
  xs.classList.remove('hide'); xs.append(h('h4', null, 'Di dalam obrolan · ' + res.length + ' hasil'));
  for (const r of res.slice(0, MAXHIT)) {
    const b = h('button', 'x-hit'); b.type = 'button';
    const av = img(r.c, 'x-av'), bd = h('span', 'x-bd'), top = h('span', 'x-top');
    top.append(h('b', null, (r.e.r === 'me' ? 'Kamu → ' : '') + r.c.name), h('small', null, r.e.t ? dayLabel(r.e.t) + ' · ' + now(r.e.t) : ''));
    bd.append(top, snippet(r.t, r.p, k.length)); b.append(av, bd);
    b.onclick = () => jump(r.c, r.i, av);
    xs.append(b);
  }
  if (res.length > MAXHIT) xs.append(h('p', 'x-more', '+' + (res.length - MAXHIT) + ' hasil lain, persempit kata kuncinya'));
}
q.addEventListener('input', () => { searchAll(); if (!xs.classList.contains('hide')) $('allempty').classList.add('hide'); }); // jalan setelah filterAll bawaan
q.addEventListener('keydown', e => { // Enter tanpa karakter yang cocok -> buka hasil pertama
  if (e.key !== 'Enter' || rows.some(r => !r.el.classList.contains('hide'))) return;
  const b = xs.querySelector('.x-hit'); if (b) { q.blur(); b.click(); }
});
$('allback').addEventListener('click', () => { xs.classList.add('hide'); xs.textContent = ''; });

/* ================= 3. Ringkasan harian ================= */
const STOP = new Set(('yang dan di ke dari ini itu aku kamu kau dia ada apa kok sih deh dong nih tuh aja saja juga udah sudah belum lagi bisa mau gak nggak ga tidak bukan atau tapi tetapi karena kalau kalo jadi untuk buat dengan sama pada dalam akan lebih sangat banget lah kan ya yaa iya oke halo hai hei terus lalu habis abis mulai masih cuma hanya dulu nanti tadi kemarin besok hari gimana bagaimana kenapa kapan siapa dimana mana kita kami mereka saya gue gw lo lu nya dah tau tahu pun pernah harus perlu boleh coba kayak seperti gitu gini begitu begini the and you bgt ajaa kok kek tuh yaudah ya').split(' '));
const RANGES = { today: 'Hari ini', yday: 'Kemarin', week: '7 hari terakhir' };
let range = 'today', lastStats = null;

const ov = h('div', 'x-ov hide'); ov.id = 'xsum';
const box = h('div', 'nbox sbox'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-labelledby', 'xsum-t'); ov.append(box);
app.append(ov);

function compute(r) {
  const n = new Date(), sod = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  const from = r === 'today' ? sod : r === 'yday' ? sod - DAY : sod - 6 * DAY, to = r === 'yday' ? sod : sod + DAY;
  const st = { r, from, label: RANGES[r], me: 0, them: 0, vn: 0, per: new Map(), hours: new Array(24).fill(0), words: new Map(), streak: 0 };
  const days = new Set(), dk = t => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  for (const c of allChars) {
    for (const e of loadLog(c.id)) {
      if (!e.t) continue; days.add(dk(e.t));
      if (e.t < from || e.t >= to) continue;
      if (e.r === 'me') {
        st.me++;
        for (const w of String(e.x || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w)) st.words.set(w, (st.words.get(w) || 0) + 1);
      } else { st.them++; if (e.r === 'vn') st.vn++; }
      st.per.set(c.id, (st.per.get(c.id) || 0) + 1); st.hours[new Date(e.t).getHours()]++;
    }
  }
  let d = days.has(sod) ? sod : sod - DAY; while (days.has(d)) { st.streak++; d -= DAY; }
  st.total = st.me + st.them;
  st.top = [...st.per].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, n2]) => ({ c: charById(id), n: n2 })).filter(x => x.c);
  st.topWords = [...st.words].filter(([, n2]) => n2 >= 2).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 8);
  const mx = Math.max(...st.hours); st.peak = mx ? st.hours.indexOf(mx) : -1;
  return st;
}
function renderSum() {
  const st = lastStats = compute(range); box.textContent = '';
  const head = h('div', 'shead'), t = h('h2', null, 'Ringkasan'); t.id = 'xsum-t';
  const x = h('button'); x.type = 'button'; x.setAttribute('aria-label', 'Tutup'); x.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'; x.onclick = closeSum;
  head.append(t, x); box.append(head);
  const seg = h('div', 'seg x3'); seg.style.marginTop = '4px';
  for (const [k, v] of Object.entries(RANGES)) { const b = h('button', k === range ? 'sel' : '', v); b.type = 'button'; b.onclick = () => { range = k; renderSum(); }; seg.append(b); }
  box.append(seg);
  const hero = h('div', 'x-hero'), big = h('div', 'x-big', String(st.me)); big.append(h('small', null, 'pesan darimu'));
  const nm = (typeof uname === 'string' && uname) || '';
  hero.append(big, h('p', 'x-sub', st.total
    ? (nm ? nm + ', ' : '') + st.label.toLowerCase() + ' kamu ngobrol dengan ' + st.per.size + ' karakter: ' + st.them + ' balasan' + (st.vn ? ', ' + st.vn + ' di antaranya voice note.' : '.')
    : ''));
  if (!st.total) { box.append(h('p', 'x-empty', 'Belum ada obrolan ' + st.label.toLowerCase() + '. Mulai ngobrol dulu, nanti rekapnya muncul di sini.')); }
  else {
    box.append(hero);
    const sec = h('div', 'x-sec'); sec.append(h('h3', null, 'Paling sering diajak ngobrol'));
    const mx = st.top[0].n;
    for (const t2 of st.top) {
      const r = h('div', 'x-ch'), a = img(t2.c), mid = h('span'), b = h('b', null, t2.c.name), bar = h('div', 'x-bar'), i = h('i');
      b.append(h('em', null, t2.n + ' pesan')); i.style.width = Math.max(6, t2.n / mx * 100) + '%'; bar.append(i); mid.append(b, bar); r.append(a, mid); sec.append(r);
    }
    box.append(sec);
    if (st.topWords.length) {
      const s2 = h('div', 'x-sec'); s2.append(h('h3', null, 'Kata yang sering kamu pakai'));
      const ch2 = h('div', 'x-chips'); for (const [w, n2] of st.topWords) { const sp = h('span', null, w); sp.append(h('em', null, '×' + n2)); ch2.append(sp); }
      s2.append(ch2); box.append(s2);
    }
    const f = h('div', 'x-facts');
    if (st.peak >= 0) f.append(h('span', null, 'Paling ramai sekitar jam ' + String(st.peak).padStart(2, '0') + ':00'));
    if (st.streak > 1) f.append(h('span', null, 'Beruntun ' + st.streak + ' hari ngobrol'));
    if (f.childNodes.length) box.append(f);
    if (st.r === 'week') box.append(h('p', 'x-sub', 'Catatan: tiap karakter menyimpan maksimal 150 pesan terakhir, jadi rekap 7 hari bisa kurang lengkap kalau kamu ngobrol banyak.'));
    const acts = h('div', 'x-acts'), sh = h('button', 'x-btn', 'Bagikan sebagai gambar'); sh.type = 'button'; sh.onclick = () => shareImg(sh);
    acts.append(sh); box.append(acts);
  }
  box.append(h('p', 'x-st')); box.lastChild.id = 'xsum-st';
}
function openSum() { range = 'today'; renderSum(); ov.classList.remove('hide'); }
function closeSum() { ov.classList.add('hide'); }
ov.addEventListener('click', e => { if (e.target === ov) closeSum(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !ov.classList.contains('hide')) { closeSum(); e.stopPropagation(); } }, true);
$('sumbtn').addEventListener('click', () => { closeSettings(); openSum(); });

/* ---- gambar untuk dibagikan (canvas 1080x1350) ---- */
const loadImg = src => new Promise(res => { if (!src) return res(null); const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
function rr(g, x, y, w, hh, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + hh, r); g.arcTo(x + w, y + hh, x, y + hh, r); g.arcTo(x, y + hh, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
async function shareImg(btn) {
  const st = lastStats, stat = $('xsum-st'); if (!st || !st.total) return;
  btn.disabled = true; stat.textContent = 'Membuat gambar…';
  try {
    const W = 1080, H = 1350, k = document.createElement('canvas'); k.width = W; k.height = H; const g = k.getContext('2d');
    const top = st.top[0], ac = top ? await hueOf(top.c) : null, hue = ac && !ac.n ? ac.h : 220, sat = ac && !ac.n ? Math.min(ac.s, 60) : 20;
    const bg = g.createLinearGradient(0, 0, W * .6, H); bg.addColorStop(0, `hsl(${hue} ${sat}% 22%)`); bg.addColorStop(1, '#0b0b0c'); g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const F = 'Inter,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif', P = 72; g.textBaseline = 'alphabetic';
    g.fillStyle = 'rgba(255,255,255,.7)'; g.font = `700 40px ${F}`; g.fillText('neyhra chat', P, 110);
    const nm = (typeof uname === 'string' && uname) || '', d0 = new Date(st.from);
    g.fillStyle = '#fff'; g.font = `700 68px ${F}`; g.fillText('Ringkasan ' + st.label.toLowerCase(), P, 250);
    g.fillStyle = 'rgba(255,255,255,.6)'; g.font = `500 34px ${F}`;
    g.fillText((nm ? nm + ' · ' : '') + d0.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) + (st.r === 'week' ? ' – sekarang' : ''), P, 305);
    g.fillStyle = '#fff'; g.font = `700 230px ${F}`; g.fillText(String(st.me), P - 6, 560);
    const wBig = g.measureText(String(st.me)).width; g.fillStyle = 'rgba(255,255,255,.65)'; g.font = `500 40px ${F}`; g.fillText('pesan darimu', P + wBig + 24, 560);
    const cells = [[st.them, 'balasan'], [st.vn, 'voice note'], [st.per.size, 'karakter']], cw = (W - P * 2 - 40) / 3;
    cells.forEach(([n2, l], i) => {
      const x = P + i * (cw + 20); g.fillStyle = 'rgba(255,255,255,.1)'; rr(g, x, 620, cw, 150, 28); g.fill();
      g.fillStyle = '#fff'; g.font = `700 60px ${F}`; g.fillText(String(n2), x + 30, 700); g.fillStyle = 'rgba(255,255,255,.6)'; g.font = `500 28px ${F}`; g.fillText(l, x + 30, 745);
    });
    let y = 850; g.fillStyle = 'rgba(255,255,255,.55)'; g.font = `600 26px ${F}`; g.fillText('PALING SERING DIAJAK NGOBROL', P, y);
    const imgs = await Promise.all(st.top.map(t => loadImg(t.c.avatar))); y += 28;
    st.top.forEach((t, i) => {
      const cy = y + 40 + i * 96;
      g.save(); g.beginPath(); g.arc(P + 38, cy, 38, 0, Math.PI * 2); g.clip();
      if (imgs[i]) g.drawImage(imgs[i], P + 0, cy - 38, 76, 76); else { g.fillStyle = '#667'; g.fillRect(P, cy - 38, 76, 76); }
      g.restore();
      g.fillStyle = '#fff'; g.font = `600 38px ${F}`; g.fillText(t.c.name, P + 104, cy + 4);
      g.fillStyle = 'rgba(255,255,255,.18)'; rr(g, P + 104, cy + 16, 560, 10, 5); g.fill();
      g.fillStyle = '#fff'; rr(g, P + 104, cy + 16, Math.max(14, 560 * t.n / st.top[0].n), 10, 5); g.fill();
      g.fillStyle = 'rgba(255,255,255,.65)'; g.font = `500 30px ${F}`; g.textAlign = 'right'; g.fillText(t.n + ' pesan', W - P, cy + 8); g.textAlign = 'left';
    });
    y += 40 + st.top.length * 96 + 14;
    if (st.topWords.length) {
      g.font = `500 32px ${F}`; let x = P, yy = y + 20;
      for (const [w, n2] of st.topWords.slice(0, 6)) {
        const label = w + ' ×' + n2, tw = g.measureText(label).width + 44;
        if (x + tw > W - P) { x = P; yy += 70; } if (yy > H - 150) break;
        g.fillStyle = 'rgba(255,255,255,.12)'; rr(g, x, yy - 40, tw, 56, 28); g.fill(); g.fillStyle = '#fff'; g.fillText(label, x + 22, yy - 2); x += tw + 14;
      }
    }
    g.fillStyle = 'rgba(255,255,255,.5)'; g.font = `500 28px ${F}`;
    g.fillText([st.peak >= 0 ? 'Paling ramai jam ' + String(st.peak).padStart(2, '0') + ':00' : '', st.streak > 1 ? st.streak + ' hari beruntun' : ''].filter(Boolean).join('  ·  '), P, H - 70);
    const blob = await new Promise(res => k.toBlob(res, 'image/png')); if (!blob) throw 0;
    const file = new File([blob], 'ringkasan-neyhra.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Ringkasan neyhra chat' }); stat.textContent = ''; btn.disabled = false; return; }
      catch (e) { if (e && e.name === 'AbortError') { stat.textContent = ''; btn.disabled = false; return; } }
    }
    saveBlob(blob, 'ringkasan-neyhra.png'); stat.textContent = 'Gambar disimpan ke perangkat.';
  } catch { stat.textContent = 'Gagal membuat gambar, coba lagi.'; }
  btn.disabled = false;
}
})();
