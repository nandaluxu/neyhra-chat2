/* ===== Sub-tab Dompet > Pencurian =====
   Spesifikasi: docs/frontend/robbery-system.md (urutan README #4). Semua angka (peluang, plafon, cooldown, harga perisai)
   DIPUTUSKAN SERVER dan ditampilkan dari respons `rates`/`stats`/`cd`/`daily`/`shield`.
   Endpoint (POST + Bearer, lewat aApi): rob, rob/attempt, rob/shield, users (cari username).
   Dimuat SETELAH wallet.js (mendaftar lewat WALLET.register). Klik notifikasi `rob` membuka sub-tab ini lewat WALLET.open('rob', { u })
   dengan `u` = nama penyerang -> kolom target terisi ("Balas menyerang"). */
(() => {
'use strict';
if (!window.WALLET || typeof WALLET.register !== 'function') return;
const $ = id => document.getElementById(id);
const nf = new Intl.NumberFormat('id-ID');
const app = $('app');
const active = () => app && app.dataset.tab === 'wallet' && !!$('rbbody');
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const poke = () => { try { window.NOTIF && NOTIF.poke(); } catch {} };
const USER_RE = /^[a-z0-9_.-]{3,20}$/;
const MASK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9c0-2 2-3 9-3s9 1 9 3v2c0 3-2 5-4 5-1.5 0-2.2-1-5-1s-3.5 1-5 1c-2 0-4-2-4-5V9zM8 11h2M14 11h2"/></svg>';
const SHIELD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3zM9 12l2 2 4-4"/></svg>';

function pushWallet(r) { // saldo header dari respons (coins/gems), tanpa request `me` tambahan
  try {
    if (!r) return;
    const cur = (typeof loadWallet === 'function' && loadWallet()) || {};
    const next = { ...cur };
    if (Number.isFinite(r.coins)) next.coins = r.coins;
    if (Number.isFinite(r.gems)) next.gems = r.gems;
    if (Number.isFinite(next.coins) && Number.isFinite(next.gems)) saveWallet(next);
  } catch {}
}
const gemsNow = () => { try { const w = typeof loadWallet === 'function' && loadWallet(); return w && Number.isFinite(w.gems) ? w.gems : 0; } catch { return 0; } };
const coinsNow = () => { try { const w = typeof loadWallet === 'function' && loadWallet(); return w && Number.isFinite(w.coins) ? w.coins : 0; } catch { return 0; } };

let toastEl = null, toastT = 0;
function say(t) {
  if (!toastEl) { toastEl = h('div', 'wl-toast'); toastEl.setAttribute('role', 'status'); toastEl.setAttribute('aria-live', 'polite'); $('wallet').append(toastEl); }
  toastEl.textContent = t; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

/* ---------- State ---------- */
const R = {
  view: null, loading: false, err: '', at: 0, tok: '',
  to: '', pick: null, res: [], resSeq: 0, resErr: '', showRes: false,
  busy: false, out: null, msg: '', msgKind: 'err',
  cdEnd: 0, shieldBusy: false
};
let qT = 0, tick = 0;

const relTime = iso => {
  const t = Date.parse(iso); if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'baru saja';
  if (s < 3600) return Math.floor(s / 60) + ' mnt lalu';
  if (s < 86400) return Math.floor(s / 3600) + ' jam lalu';
  return Math.floor(s / 86400) + ' hari lalu';
};
const clock = ms => { const s = Math.ceil(Math.max(0, ms) / 1000), m = Math.floor(s / 60); return m + ' mnt ' + String(s % 60).padStart(2, '0') + ' dtk'; };
const when = ms => new Date(ms).toLocaleString('id-ID', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const cdLeft = () => Math.max(0, R.cdEnd - Date.now());
const shieldLeft = () => Math.max(0, ((R.view && R.view.shield && R.view.shield.until) || 0) - Date.now());

async function load(force) {
  if (typeof atok !== 'string' || !atok || R.loading) return;
  if (!force && R.view && Date.now() - R.at < 4000) return;
  R.loading = true; R.err = ''; if (active() && !R.view) render();
  try {
    const r = await aApi('rob');
    if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal memuat pencurian.');
    R.view = r; R.at = Date.now(); R.cdEnd = Date.now() + (Number(r.cd && r.cd.leftMs) || 0);
  } catch (e) { if (!(e && e.status === 401)) R.err = (e && e.message) || 'Gagal memuat pencurian.'; }
  R.loading = false;
  if (active()) render();
}

/* alasan tombol Incari nonaktif (null = boleh). Saldo orang lain TIDAK divalidasi di client. */
function problem() {
  const v = R.view; if (!v) return 'Memuat…';
  if (R.busy) return '';
  if (cdLeft() > 0) return 'Tunggu ' + clock(cdLeft()) + ' lagi.';
  if (v.daily.used >= v.daily.max) return 'Kuota hari ini habis (' + v.daily.max + ' percobaan). Coba lagi besok.';
  if (coinsNow() < v.rates.stake) return 'Dompetmu minimal ' + nf.format(v.rates.stake) + ' Coin untuk modal ganti rugi.';
  if (!USER_RE.test(R.to)) return R.to ? 'Username tidak valid.' : 'Ketik username yang mau diincar.';
  return null;
}

/* ---------- Render ---------- */
function render() {
  const body = $('rbbody'); if (!body) return;
  const keep = $('rbto') && document.activeElement === $('rbto'); // jaga fokus kalau render ulang saat mengetik
  body.textContent = '';
  if (!R.view && !R.err) { body.append(skeleton()); return; }
  if (R.err && !R.view) {
    const g = h('div', 'wl-gate'); g.append(h('h2', null, 'Gagal memuat'), h('p', null, R.err));
    const b = h('button', 'wl-btn', 'Coba lagi'); b.type = 'button'; b.addEventListener('click', () => load(true)); g.append(b); body.append(g); return;
  }
  const v = R.view, grid = h('div', 'wl-grid'), left = h('div', 'wl-col'), right = h('div', 'wl-col');

  /* --- hasil percobaan terakhir --- */
  if (R.out) left.append(outcomeCard(R.out));

  /* --- status pencuri --- */
  const st = h('section', 'wl-card rb-status');
  st.append(h('h3', null, 'Statusmu'));
  const g = h('div', 'rb-stats');
  g.append(stat('Dompet', nf.format(coinsNow()), 'Modal & bisa dicuri'), stat('Percobaan', v.daily.used + '/' + v.daily.max, 'hari ini'));
  const cd = stat('Cooldown', '', ''); cd.querySelector('b').id = 'rbcd'; cd.querySelector('.rb-sub').id = 'rbcds';
  g.append(cd); st.append(g);
  const w = v.stats, wr = h('div', 'rb-wanted');
  const wt = h('div', 'wl-bartop'); wt.append(h('span', null, 'Wanted (buronan)'), h('b', null, w.wanted + '/' + w.wantedMax));
  const tr = h('div', 'wl-track rb-wtrack'); tr.setAttribute('role', 'meter'); tr.setAttribute('aria-valuemin', '0'); tr.setAttribute('aria-valuemax', String(w.wantedMax)); tr.setAttribute('aria-valuenow', String(w.wanted));
  const fl = h('i'); fl.style.width = Math.max(0, Math.min(100, w.wantedMax ? w.wanted / w.wantedMax * 100 : 0)) + '%'; tr.append(fl);
  wr.append(wt, tr, h('small', 'wl-small', 'Peluang kamu dijarah: ' + Math.round((w.chanceOfMe || 0) * 100) + '%. Wanted turun 1 poin tiap ' + v.rates.wantedDecayH + ' jam.'));
  st.append(wr); left.append(st);

  /* --- form target --- */
  const form = h('section', 'wl-card rb-form'); form.append(h('h3', null, 'Incar pemain'));
  const f1 = h('div', 'wl-field'), l1 = h('label', null, 'Username target'); l1.htmlFor = 'rbto';
  const wrap = h('div', 'wl-ac');
  const inp = h('input'); inp.id = 'rbto'; inp.type = 'text'; inp.placeholder = 'mis. bravo'; inp.autocomplete = 'off'; inp.autocapitalize = 'off'; inp.spellcheck = false; inp.maxLength = 20; inp.value = R.to; inp.disabled = R.busy;
  inp.setAttribute('aria-autocomplete', 'list'); inp.setAttribute('aria-controls', 'rbres');
  wrap.append(inp); const res = h('div', 'wl-res'); res.id = 'rbres'; res.setAttribute('role', 'listbox'); wrap.append(res);
  f1.append(l1, wrap);
  if (R.pick && R.pick.username === R.to) { const chip = h('div', 'wl-chip'); chip.append(avatar(R.pick), h('span', null, R.pick.name || R.pick.username), h('small', null, '@' + R.pick.username)); f1.append(chip); }
  form.append(f1);
  const em = h('div', 'wl-msg hide'); em.id = 'rbmsg'; em.setAttribute('role', 'alert'); form.append(em);
  const why = h('p', 'wl-why'); why.id = 'rbwhy';
  const go = h('button', 'wl-btn rb-go', 'Incari!'); go.type = 'button'; go.id = 'rbgo';
  form.append(why, go);
  form.append(h('p', 'wl-small', 'Peluang dasar ' + Math.round(v.rates.baseChance * 100) + '%, naik sesuai wanted target. Berhasil: ' + Math.round(v.rates.stealPct[0] * 100) + '–' + Math.round(v.rates.stealPct[1] * 100) + '% dompet korban (maks ' + nf.format(v.rates.maxStolen) + '). Gagal: kamu bayar ganti rugi ke korban.'));
  left.append(form);

  /* --- perisai --- */
  const sh = h('section', 'wl-card rb-shield');
  const on = shieldLeft() > 0;
  const top = h('div', 'rb-shtop'), ic = h('span', 'rb-shic' + (on ? ' on' : '')); ic.innerHTML = SHIELD;
  const tx = h('div'); tx.append(h('b', null, on ? 'Perisai aktif' : 'Tanpa perisai'), h('small', null, on ? 's/d ' + when(v.shield.until) : 'Coin di dompet bisa dijarah kapan saja'));
  top.append(ic, tx); sh.append(top);
  sh.append(h('p', 'wl-small', 'Perisai memblokir semua percobaan pencurian selama ' + v.shield.hours + ' jam dan bisa ditumpuk. Pencuri yang menabrak perisai tetap bayar ganti rugi ke kamu. Setor ke Bank untuk perlindungan permanen.'));
  const sb = h('button', 'wl-btn alt', R.shieldBusy ? 'Membeli…' : 'Beli perisai ' + v.shield.hours + ' jam — ' + v.shield.gems + ' Gems'); sb.type = 'button'; sb.id = 'rbsh';
  sb.disabled = R.shieldBusy || gemsNow() < v.shield.gems; sh.append(sb);
  if (gemsNow() < v.shield.gems) sh.append(h('p', 'wl-small', 'Gems kamu: ' + nf.format(gemsNow()) + ' (butuh ' + v.shield.gems + ').'));
  right.append(sh);

  /* --- statistik karier --- */
  const sc = h('section', 'wl-card'); sc.append(h('h3', null, 'Statistik karier'));
  const sg = h('div', 'rb-career');
  for (const [k, val] of [['Berhasil', w.win], ['Gagal', w.fail], ['Total curian', w.got], ['Ganti rugi dibayar', w.fine], ['Total dijarah', w.lost], ['Ganti rugi diterima', w.back]]) {
    const c = h('div'); c.append(h('small', null, k), h('b', null, nf.format(val || 0))); sg.append(c);
  }
  sc.append(sg); right.append(sc);

  /* --- riwayat --- */
  const hc = h('section', 'wl-card'); hc.append(h('h3', null, 'Riwayat'));
  const hist = v.hist || [];
  if (!hist.length) hc.append(h('p', 'wl-empty', 'Belum ada kejadian. Semua orang mulai dari bersih... untuk saat ini.'));
  else { const ul = h('ul', 'rb-hist'); for (const e of hist) ul.append(histRow(e)); hc.append(ul); }
  right.append(hc);

  grid.append(left, right); body.append(grid);
  if (keep) { const i = $('rbto'); if (i) { i.focus(); const n = i.value.length; i.setSelectionRange(n, n); } }
  paintCd(); paintGo(); paintMsg();
  if (R.showRes) paintRes();
  startTick();
}

const stat = (k, val, sub) => { const c = h('div', 'rb-stat'); c.append(h('small', null, k), h('b', null, val), h('small', 'rb-sub', sub)); return c; };
function avatar(u) {
  const a = h('span', 'wl-av', (String(u.name || u.username || '?').trim()[0] || '?').toUpperCase()); a.setAttribute('aria-hidden', 'true');
  if (u.avatar) { const im = new Image(); im.alt = ''; im.decoding = 'async'; im.draggable = false; im.referrerPolicy = 'no-referrer'; im.onerror = () => im.remove(); im.src = u.avatar; a.append(im); }
  return a;
}
function skeleton() {
  const g = h('div', 'wl-grid'), a = h('div', 'wl-col'), b = h('div', 'wl-col');
  for (const [c, hh] of [[a, 200], [a, 220], [b, 180], [b, 160]]) { const s = h('div', 'wl-sk'); s.style.height = hh + 'px'; s.setAttribute('aria-hidden', 'true'); c.append(s); }
  g.append(a, b); return g;
}

/* panel hasil: kejadian ditulis sebagai TEKS (bukan cuma warna/ikon) */
function outcomeCard(o) {
  const c = h('section', 'wl-card rb-out ' + o.out); c.setAttribute('role', 'status');
  const ic = h('span', 'rb-outic'); ic.innerHTML = MASK; const t = h('div', 'rb-outt');
  const name = o.name || '@' + o.to, dW = o.dWanted;
  if (o.out === 'win') { t.append(h('b', null, 'Berhasil!'), h('p', null, 'Kamu mencuri ' + nf.format(o.stolen) + ' Coin dari ' + name + '.')); }
  else if (o.out === 'shield') { t.append(h('b', null, 'Digagalkan perisai'), h('p', null, 'Perisai ' + name + ' menggagalkanmu — kamu bayar ganti rugi ' + nf.format(o.fine) + ' Coin.')); }
  else { t.append(h('b', null, 'Ketahuan!'), h('p', null, 'Kamu membayar ganti rugi ' + nf.format(o.fine) + ' Coin ke ' + name + '.')); }
  const meta = []; if (Number.isFinite(dW) && dW !== 0) meta.push('Wanted ' + (dW > 0 ? '+' : '') + dW + ' (sekarang ' + o.wanted + ')'); else if (Number.isFinite(o.wanted)) meta.push('Wanted ' + o.wanted);
  t.append(h('small', null, meta.join(' · ')));
  const x = h('button', 'wl-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Tutup'); x.addEventListener('click', () => { R.out = null; render(); });
  c.append(ic, t, x); return c;
}
function histRow(e) {
  const atk = e.role === 'atk', li = h('li', 'rb-h ' + e.out);
  const role = h('span', 'rb-role', atk ? 'PENCURI' : 'KORBAN');
  const who = h('b', null, e.other || '—');
  let txt, sign = '';
  if (e.out === 'win') { txt = atk ? 'Berhasil' : 'Dijarah'; sign = (atk ? '+' : '−') + nf.format(e.amt || 0); }
  else if (e.out === 'shield') { txt = atk ? 'Kena perisai' : 'Perisai menahan'; sign = (atk ? '−' : '+') + nf.format(e.fine || 0); }
  else { txt = atk ? 'Gagal' : 'Pencuri gagal'; sign = (atk ? '−' : '+') + nf.format(e.fine || 0); }
  const mid = h('div', 'rb-hm'); mid.append(who, h('small', null, txt + ' · ' + relTime(e.at)));
  const amt = h('span', 'rb-amt ' + (sign[0] === '+' ? 'pos' : 'neg'), sign);
  li.append(role, mid, amt); return li;
}

/* ---------- Bagian yang diperbarui tanpa render ulang ---------- */
function paintCd() {
  const el = $('rbcd'), s = $('rbcds'); if (!el) return;
  const l = cdLeft();
  el.textContent = l > 0 ? clock(l) : 'Siap'; if (s) s.textContent = l > 0 ? 'sampai bisa mencuri' : 'bisa mencuri';
  el.classList.toggle('ready', l <= 0);
}
function paintGo() {
  const go = $('rbgo'), why = $('rbwhy'); if (!go) return;
  const p = problem();
  go.disabled = !!p || R.busy; go.classList.toggle('busy', R.busy);
  go.textContent = R.busy ? 'Menyusup…' : (cdLeft() > 0 ? 'Tunggu ' + clock(cdLeft()) : 'Incari!');
  if (why) why.textContent = R.busy ? '' : (p && (R.to || cdLeft() > 0) ? p : (p ? 'Ketik username target, lalu tekan Incari.' : ''));
}
function paintMsg() { const m = $('rbmsg'); if (!m) return; m.textContent = R.msg || ''; m.className = 'wl-msg' + (R.msg ? ' ' + R.msgKind : ' hide'); }
function paintRes() {
  const box = $('rbres'); if (!box) return;
  box.textContent = '';
  const inp = $('rbto'), open = R.showRes && (document.activeElement === inp || box.contains(document.activeElement)) && (R.res.length || R.resErr);
  box.classList.toggle('open', !!open); if (!open) return;
  if (R.resErr) { box.append(h('div', 'wl-resmsg', R.resErr)); return; }
  for (const u of R.res) {
    const b = h('button', 'rb-resrow'); b.type = 'button'; b.setAttribute('role', 'option'); b.dataset.u = u.username; b.dataset.n = u.name || '';
    const t = h('span', 'wl-rt'); t.append(h('b', null, u.name || u.username), h('small', null, '@' + u.username));
    b.append(avatar(u), t); box.append(b);
  }
}
function startTick() { // hitung mundur cooldown (tanpa polling); berhenti sendiri kalau layar ditinggalkan
  clearInterval(tick);
  tick = setInterval(() => {
    if (!active()) { clearInterval(tick); return; }
    const was = $('rbcd') && $('rbcd').classList.contains('ready'); paintCd(); paintGo();
    if (!was && cdLeft() <= 0 && R.view) paintGo();
  }, 1000);
}

async function searchUsers(q) {
  const seq = ++R.resSeq; R.resErr = '';
  try {
    const r = await aApi('users', { q });
    if (seq !== R.resSeq) return;
    R.res = ((r && r.items) || []).filter(u => !u.isMe).slice(0, 6);
  } catch (e) { if (seq !== R.resSeq || (e && e.status === 401)) return; R.res = []; R.resErr = (e && e.message) || 'Gagal mencari.'; }
  paintRes();
}

/* ---------- Aksi ---------- */
async function attempt() {
  if (R.busy || problem()) return;
  const to = R.to, prevW = R.view && R.view.stats ? R.view.stats.wanted : 0, label = R.pick && R.pick.username === to ? (R.pick.name || '@' + to) : '@' + to;
  R.busy = true; R.msg = ''; paintMsg(); paintGo();
  const inp = $('rbto'); if (inp) inp.disabled = true;
  try {
    const t0 = Date.now();
    const r = await aApi('rob/attempt', { username: to });
    if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal mencuri.');
    await wait(Math.max(0, 700 - (Date.now() - t0))); // jeda kecil untuk ketegangan; angkanya tetap dari server
    pushWallet(r);
    R.out = { out: r.out, stolen: r.stolen, fine: r.fine, wanted: r.wanted, dWanted: Number.isFinite(r.wanted) ? r.wanted - prevW : NaN, to, name: label };
    R.busy = false; R.cdEnd = Date.now() + ((R.view && R.view.rates && R.view.rates.cdMin) || 30) * 60000; // cooldown langsung terasa; load() di bawah menyamakan dengan server
    if (R.view) R.view.daily.used++;
    try { navigator.vibrate && navigator.vibrate(r.out === 'win' ? 40 : [30, 40, 30]); } catch {}
    poke(); render(); load(true);
  } catch (e) {
    R.busy = false;
    if (e && e.status === 401) return;
    R.msg = (e && e.message) || 'Gagal mencuri.'; R.msgKind = 'err';
    if (e && e.status === 429) load(true); // cooldown/kuota: ambil hitung mundur terbaru dari server
    render();
  }
}
async function buyShield() {
  const v = R.view; if (!v || R.shieldBusy || gemsNow() < v.shield.gems) return;
  R.shieldBusy = true; render();
  try {
    const r = await aApi('rob/shield', {});
    if (!r || !r.ok) throw new Error((r && r.error) || 'Gagal membeli perisai.');
    pushWallet({ gems: r.gems });
    R.view.shield.until = r.shieldUntil; R.shieldBusy = false; R.msg = ''; render(); say('Perisai aktif s/d ' + when(r.shieldUntil)); poke();
  } catch (e) {
    R.shieldBusy = false;
    if (e && e.status === 401) return;
    if (e && Number.isFinite(e.gems)) pushWallet({ gems: e.gems });
    R.msg = (e && e.message) || 'Gagal membeli perisai.'; R.msgKind = 'err'; render();
  }
}

/* ---------- Event (delegasi di #wtbody; hanya saat sub-tab ini tampil) ---------- */
const body = $('wtbody');
body.addEventListener('input', e => {
  if (e.target.id !== 'rbto') return;
  const t = e.target; t.value = t.value.toLowerCase().replace(/[^a-z0-9_.-]/g, ''); R.to = t.value; if (R.pick && R.pick.username !== R.to) R.pick = null;
  R.msg = ''; paintMsg(); clearTimeout(qT); R.showRes = true;
  if (R.to.length >= 1) qT = setTimeout(() => searchUsers(R.to), 250); else { R.res = []; paintRes(); }
  paintGo();
});
body.addEventListener('focusin', e => { if (e.target.id === 'rbto') { R.showRes = true; if (!R.res.length && !R.to) searchUsers(''); paintRes(); } });
body.addEventListener('focusout', e => {
  if (e.target.id !== 'rbto' && !(e.target.closest && e.target.closest('#rbres'))) return;
  if (e.relatedTarget && e.relatedTarget.closest && (e.relatedTarget.closest('#rbres') || e.relatedTarget.id === 'rbto')) return;
  setTimeout(() => { if (document.activeElement && document.activeElement.closest && document.activeElement.closest('.wl-ac')) return; R.showRes = false; paintRes(); }, 150);
});
body.addEventListener('keydown', e => {
  if (!$('rbbody')) return;
  const rows = () => [...body.querySelectorAll('#rbres .rb-resrow')];
  if (e.target.id === 'rbto') {
    if (e.key === 'ArrowDown') { const r = rows(); if (r.length) { e.preventDefault(); r[0].focus(); } }
    else if (e.key === 'Enter') { e.preventDefault(); attempt(); }
  } else if (e.target.classList && e.target.classList.contains('rb-resrow') && e.target.closest('#rbres')) {
    const r = rows(), i = r.indexOf(e.target);
    if (e.key === 'ArrowDown') { e.preventDefault(); (r[i + 1] || r[0]).focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (i <= 0) $('rbto').focus(); else r[i - 1].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); $('rbto').focus(); R.showRes = false; paintRes(); }
  }
});
body.addEventListener('mousedown', e => { if (e.target.closest('#rbres .rb-resrow')) e.preventDefault(); });
body.addEventListener('click', e => {
  if (!$('rbbody')) return;
  const rr = e.target.closest('#rbres .rb-resrow');
  if (rr) { R.to = rr.dataset.u; R.pick = { username: rr.dataset.u, name: rr.dataset.n, avatar: ((R.res.find(u => u.username === rr.dataset.u) || {}).avatar) || '' }; R.showRes = false; R.res = []; R.msg = ''; render(); return; }
  if (e.target.closest('#rbgo') && !e.target.closest('#rbgo').disabled) attempt();
  else if (e.target.closest('#rbsh') && !e.target.closest('#rbsh').disabled) buyShield();
});

/* ---------- Daftarkan sub-tab ---------- */
WALLET.register('rob', {
  label: 'Pencurian', title: 'Pencurian', sub: 'Coba curi Coin di dompet pemain lain. Berisiko: kalau ketahuan kamu bayar ganti rugi.',
  onOpen(meta) { if (meta && meta.u) { const u = String(meta.u).toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 20); R.to = u; R.pick = null; R.msg = ''; } R.out = null; },
  render(ctx) { ctx.body.textContent = ''; const box = h('div'); box.id = 'rbbody'; ctx.body.append(box); render(); load(true); }
});
window.addEventListener('acct', () => { // ganti akun / keluar: bersihkan state
  const tok = typeof atok === 'string' ? atok : '';
  if (R.tok !== tok) { R.tok = tok; R.view = null; R.out = null; R.to = ''; R.pick = null; R.msg = ''; R.cdEnd = 0; }
});
window.addEventListener('notif:new', e => { // jadi korban saat layar terbuka: muat ulang statistik & riwayat
  const types = (e.detail && e.detail.types) || [];
  if (active() && !R.busy && types.includes('rob')) load(true);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && active()) load(true); });
})();
