/* ===== Tab Bonus: misi harian + klaim harian (streak) + peringkat mingguan + kode referal =====
   Dimuat setelah shell.js, sebelum router.js. Semua hadiah dan saldo diatur server (lib/bonus.js + lib/quests.js + lib/auth.js):
   di sini hanya menampilkan dan memanggil /api/auth/bonus, /claim, /redeem, /quests.
   Memakai global index.html: atok, aOn, aApi, saveWallet, loadWallet, paintWallet, toast (let/const global, akses langsung).
   Kejadian: 'shell:tab' (dari Shell.setTab) dan 'acct' (dari paintAcct) menyegarkan halaman ini. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const app = $('app'), body = $('bnbody');
const nf = new Intl.NumberFormat('id-ID');
const active = () => app.dataset.tab === 'bonus';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let st = null;          // keadaan terakhir dari server { refCode, invited, redeemed, ref, daily, coins, gems }
let qs = null;          // keadaan misi/piala/peringkat dari /api/auth/quests { quests, ach, streak, lb, resetMs }
let ready = false;      // status akun (aktif/tidak) sudah diketahui
let failed = '';        // pesan kalau gagal memuat
let busy = false, lastTok = '', lastAt = 0, resetAt = 0, tick = 0;
const msgs = { daily: ['', ''], ref: ['', ''], redeem: ['', ''] }; // [teks, kelas 'ok'|'err']

const SVG = {
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 017.5 4H15"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V3M8 7l4-4 4 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  qchat: '<svg viewBox="0 0 24 24"><path d="M5 5h14a2 2 0 012 2v8a2 2 0 01-2 2h-7l-5 4v-4H5a2 2 0 01-2-2V7a2 2 0 012-2zM8 10h8M8 13h5"/></svg>',
  qchars: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 19c.6-3.4 3.2-5.2 6.5-5.2s5.9 1.8 6.5 5.2M16 5.4a3.5 3.5 0 010 6.2M18 14.5c1.9.7 3.1 2.3 3.5 4.5"/></svg>',
  qgame: '<svg viewBox="0 0 24 24"><path d="M6 12h4M8 10v4M15 13h.01M18 11h.01"/><path d="M17.32 5H6.68a4 4 0 00-3.98 3.59C2.6 9.42 2 14.46 2 16a3 3 0 003 3c1 0 1.5-.5 2-1l1.41-1.41A2 2 0 019.83 16h4.34a2 2 0 011.41.59L17 18c.5.5 1 1 2 1a3 3 0 003-3c0-1.55-.6-6.58-.68-7.26A4 4 0 0017.32 5z"/></svg>',
  qgift: '<svg viewBox="0 0 24 24"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M5 12v8a1 1 0 001 1h12a1 1 0 001-1v-8M7.5 8a2.5 2.5 0 010-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 010 5"/></svg>',
  trophy: '<svg viewBox="0 0 24 24"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0V4zM7 6H4a3 3 0 003 4M17 6h3a3 3 0 01-3 4"/></svg>'
};
const QICON = { chat: SVG.qchat, chars: SVG.qchars, game: SVG.qgame, gift: SVG.qgift };

const rewardText = r => [r && r.c ? nf.format(r.c) + ' coin' : '', r && r.g ? nf.format(r.g) + ' gems' : ''].filter(Boolean).join(' + ');
const isGem = r => !!(r && r.g && !r.c);
const icon = r => isGem(r) ? '/gems.png' : '/coin.svg';
const amount = r => nf.format(isGem(r) ? r.g : (r && r.c) || 0);
const clock = ms => { const s = Math.max(0, Math.ceil(ms / 1000)), p = n => String(n).padStart(2, '0'); return p(Math.floor(s / 3600)) + ':' + p(Math.floor(s % 3600 / 60)) + ':' + p(s % 60); };

function setMsg(k, text, cls) {
  msgs[k] = [text || '', cls || ''];
  const el = body.querySelector('.bn-msg[data-m="' + k + '"]');
  if (el) { el.textContent = msgs[k][0]; el.className = 'bn-msg' + (cls ? ' ' + cls : ''); }
}

const empty = (title, text, btn) => '<div class="bn-empty"><h2>' + esc(title) + '</h2>' + (text ? '<p>' + esc(text) + '</p>' : '') + (btn || '') + '</div>';

function refLine() {
  const a = rewardText(st.ref && st.ref.inviter), b = rewardText(st.ref && st.ref.invitee);
  if (a && b) return ' Tiap teman yang memakainya: kamu dapat ' + a + ', temanmu dapat ' + b + '.';
  if (a) return ' Tiap teman yang memakainya, kamu dapat ' + a + '.';
  if (b) return ' Temanmu yang memakainya dapat ' + b + '.';
  return '';
}

/* ---------- Kartu misi harian + peringkat (data /api/auth/quests) ---------- */
function questCard() {
  if (!qs || !Array.isArray(qs.quests)) return ''; // belum termuat / gagal: kartu tidak tampil dulu
  const d = qs;
  const items = d.quests.map(q => {
    const pct = Math.min(100, Math.round(q.progress / q.target * 100));
    return '<div class="bn-q' + (q.done ? ' done' : '') + '" role="listitem">' +
      '<span class="bn-qi">' + (QICON[q.icon] || SVG.qchat) + '</span>' +
      '<div class="bn-qb"><b>' + esc(q.title) + '</b>' +
        '<div class="bn-qbar"><i style="width:' + pct + '%"></i></div>' +
        '<small>' + (q.done ? 'Selesai' : nf.format(q.progress) + ' dari ' + nf.format(q.target)) + ' · hadiah ' + esc(rewardText(q.reward)) + '</small></div>' +
      (q.done ? '<span class="bn-qok">' + SVG.check + '</span>' : '') +
      '</div>';
  }).join('');
  const doneN = d.quests.filter(q => q.done).length;
  return '<div class="bn-card"><h2>Misi hari ini</h2>' +
    '<p class="bn-hint">Selesaikan misi untuk dapat coin dan poin peringkat. Misi berganti tiap 00.00 WIB.</p>' +
    '<div class="bn-qs" role="list">' + items + '</div>' +
    '<p class="bn-qnote"><b>' + doneN + '/3 selesai</b><span>ganti misi dalam <span id="bnqc">–</span></span></p></div>';
}

function lbCard() {
  if (!qs || !qs.lb) return '';
  const lb = qs.lb;
  const rows = (lb.top || []).map((r, i) =>
    '<div class="bn-lbrow' + (r.me ? ' me' : '') + '"><b class="bn-rank">' + (i + 1) + '</b>' +
    (r.avatar ? '<img src="' + esc(r.avatar) + '" alt="" draggable="false">' : '<i class="bn-lbph">' + esc(String(r.name || '?').charAt(0).toUpperCase()) + '</i>') +
    '<span>' + esc(r.name) + (r.me ? ' (kamu)' : '') + '</span><b class="bn-pts">' + nf.format(r.pts) + '</b></div>'
  ).join('');
  const mine = lb.mine
    ? '<p class="bn-hint">Posisimu: <b>#' + lb.rank + '</b> dengan ' + nf.format(lb.pts) + ' poin. Tiap misi selesai = 10 poin.</p>'
    : '<p class="bn-hint">Belum ada poin minggu ini. Selesaikan misi harian untuk masuk peringkat (10 poin per misi).</p>';
  return '<div class="bn-card"><h2>Peringkat minggu ini</h2>' +
    (rows ? '<div class="bn-lb" role="list">' + rows + '</div>' : '<p class="bn-hint">Belum ada yang menyelesaikan misi minggu ini. Jadilah yang pertama.</p>') +
    mine + '</div>';
}

function render() {
  clearInterval(tick); tick = 0;
  if (!ready && !aOn) { body.innerHTML = empty('Memuat…'); return; }
  if (!aOn) { body.innerHTML = empty('Bonus belum tersedia', 'Fitur akun belum aktif di server ini, jadi bonus, misi, dan peringkat belum bisa dipakai.'); return; }
  if (!atok) { body.innerHTML = empty('Masuk dulu ya', 'Misi harian, bonus, dan peringkat tersimpan di akunmu, jadi kamu perlu masuk atau daftar dulu.', '<button class="bn-go" type="button" data-act="login">Masuk / Daftar</button>'); return; }
  if (!st) { body.innerHTML = failed ? empty('Gagal memuat', failed, '<button class="bn-go" type="button" data-act="retry">Coba lagi</button>') : empty('Memuat…'); return; }

  const d = st.daily, total = d.rewards.length;
  const days = d.rewards.map((r, i) => {
    const n = i + 1, done = n <= d.claimedDays, on = !d.claimedToday && n === d.claimDay, next = d.claimedToday && n === d.claimDay && d.claimedDays < total;
    const label = 'Hari ' + n + ': ' + rewardText(r) + (done ? ', sudah diklaim' : on ? ', bisa diklaim sekarang' : '');
    return '<div class="bn-day' + (done ? ' done' : '') + (on ? ' on' : '') + (next ? ' next' : '') + '" role="listitem" aria-label="' + esc(label) + '"' + (on ? ' aria-current="step"' : '') + '>' +
      '<span class="d">' + (next ? 'Besok' : 'Hari ' + n) + '</span><img src="' + icon(r) + '" alt="" draggable="false"><b>+' + amount(r) + '</b></div>';
  }).join('');
  const nextBonus = d.claimedToday ? 0 : d.streakBonus;
  const btn = d.claimedToday
    ? '<button class="bn-btn" type="button" data-act="claim" disabled>Klaim lagi dalam <span id="bncd">' + clock(resetAt - Date.now()) + '</span></button>'
    : '<button class="bn-btn" type="button" data-act="claim">Klaim hari ke-' + d.claimDay + ' · ' + esc(rewardText(d.rewards[d.claimDay - 1])) + (nextBonus ? ' + ' + nextBonus + ' coin' : '') + '</button>';
  const streakLine = d.streak > 0
    ? ' Streak klaimmu <b>' + nf.format(d.streak) + ' hari</b> (rekor ' + nf.format(d.streakMax) + ')' + (d.claimedToday ? '' : ' · klaim hari ini dapat bonus <b>+' + nf.format(nextBonus) + ' coin</b>')
    : '';
  const hint = (d.claimedDays > 0 || d.streak > 0) && !d.claimedToday
    ? 'Klaim hari ini supaya streakmu tidak putus.' + streakLine
    : 'Masuk tiap hari untuk hadiah makin besar.' + (d.streak > 1 ? ' Tiap hari streak menambah bonus klaim (+5 coin per hari, maks +100).' : ' Klaim berturut-turut menambah bonus coin tiap harinya.') + streakLine;
  const canShare = typeof navigator.share === 'function';
  const inv = rewardText(st.ref && st.ref.invitee);

  body.innerHTML =
    questCard() +
    '<div class="bn-card"><h2>Klaim harian</h2><p class="bn-hint">' + hint.replace(/<b>/g, '<b class="bn-b">') + '</p>' +
      '<div class="bn-days" role="list">' + days + '</div>' + btn + '<p class="bn-msg" data-m="daily" role="status"></p></div>' +
    lbCard() +
    '<div class="bn-card"><h2>Kode referalmu</h2><p class="bn-hint">Bagikan kode ini ke temanmu.' + esc(refLine()) + '</p>' +
      '<div class="bn-code"><code id="bncode">' + esc(st.refCode) + '</code>' +
        '<button class="bn-ic" type="button" data-act="copy" aria-label="Salin kode" title="Salin kode">' + SVG.copy + '</button>' +
        (canShare ? '<button class="bn-ic" type="button" data-act="share" aria-label="Bagikan kode" title="Bagikan">' + SVG.share + '</button>' : '') + '</div>' +
      '<div class="bn-stat"><b>' + nf.format(st.invited) + '</b><span>orang yang kamu undang</span></div><p class="bn-msg" data-m="ref" role="status"></p></div>' +
    '<div class="bn-card"><h2>Punya kode dari teman?</h2>' + (st.redeemed
      ? '<div class="bn-done">' + SVG.check + '<span>Kode referal sudah kamu pakai.</span></div>'
      : '<p class="bn-hint">Masukkan kode dari temanmu' + (inv ? ' untuk dapat ' + esc(inv) : '') + '. Hanya bisa dipakai sekali per akun.</p>' +
        '<div class="bn-row"><input class="bn-f" id="bnin" maxlength="12" placeholder="Masukkan kode" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="done" aria-label="Kode referal">' +
        '<button class="bn-btn" type="button" data-act="redeem">Pakai</button></div>') +
      '<p class="bn-msg" data-m="redeem" role="status"></p></div>';

  for (const k in msgs) setMsg(k, msgs[k][0], msgs[k][1]);
  if (d.claimedToday) {
    tick = setInterval(() => {
      const left = resetAt - Date.now(), el = $('bncd');
      if (left <= 0) { clearInterval(tick); tick = 0; load(true); return; } // hari baru: ambil keadaan terbaru
      if (el) el.textContent = clock(left);
      const qc = $('bnqc'); if (qc) qc.textContent = clock(left);
    }, 1000);
  } else if (qs && Number.isFinite(qs.resetMs)) {
    const qEnd = Date.now() + qs.resetMs;
    tick = setInterval(() => { const qc = $('bnqc'); if (!qc) { clearInterval(tick); tick = 0; return; } const left = qEnd - Date.now(); if (left > 0) qc.textContent = clock(left); }, 1000);
  }
}

/* ---------- Server ---------- */
const stamp = () => { resetAt = Date.now() + st.daily.resetMs; };
async function fetchState() {
  try {
    // bonus + misi diambil bersamaan; misi gagal tidak boleh membuat seluruh tab gagal
    const [r, q] = await Promise.all([aApi('bonus'), aApi('quests').catch(() => null)]);
    if (r && r.ok) { st = r; failed = ''; stamp(); saveWallet(r); qs = q && q.ok ? q : qs; return true; }
    failed = (r && r.error) || 'Gagal memuat bonus.';
  } catch (e) { failed = e && e.status === 401 ? '' : (e && e.message) || 'Tidak bisa terhubung ke server.'; }
  return false;
}
async function load(force) {
  if (lastTok !== atok) { lastTok = atok; st = null; qs = null; failed = ''; for (const k in msgs) msgs[k] = ['', '']; }
  if (!aOn || !atok) { st = null; qs = null; render(); return; }
  if (busy || (!force && st && Date.now() - lastAt < 3000)) { render(); return; }
  busy = true; if (!st) render();
  await fetchState();
  lastAt = Date.now(); busy = false; render();
}

async function claim() {
  if (busy) return; busy = true;
  const b = body.querySelector('[data-act="claim"]'); if (b) b.disabled = true;
  try {
    const r = await aApi('claim');
    if (r && r.ok) {
      st.daily = r.daily; st.coins = r.coins; st.gems = r.gems; stamp(); saveWallet(r);
      setMsg('daily', '+' + rewardText(r.reward) + (r.streakBonus ? ' +' + r.streakBonus + ' coin (streak ' + r.streak + ' hari)' : '') + ' masuk ke saldomu.', 'ok');
      load(true); // misi "klaim bonus" ikut tercapai server-side: muat ulang kartu misi + peringkat
    }
  } catch (e) {
    setMsg('daily', e.message || 'Gagal klaim, coba lagi.', 'err');
    await fetchState(); // misalnya sudah diklaim dari perangkat lain: ikut keadaan server
  }
  busy = false; render();
}

async function redeem() {
  if (busy) return;
  const inp = $('bnin'), code = inp ? inp.value.trim() : '';
  if (!code) { setMsg('redeem', 'Masukkan kodenya dulu.', 'err'); if (inp) inp.focus(); return; }
  busy = true;
  const b = body.querySelector('[data-act="redeem"]'); if (b) b.disabled = true;
  try {
    const r = await aApi('redeem', { code });
    if (r && r.ok) {
      st.redeemed = true; st.coins = r.coins; st.gems = r.gems; saveWallet(r);
      const t = rewardText(r.reward);
      setMsg('redeem', 'Berhasil!' + (t ? ' +' + t + ' masuk ke saldomu.' : ''), 'ok');
    }
  } catch (e) { setMsg('redeem', e.message || 'Gagal memakai kode.', 'err'); }
  busy = false; render();
}

async function copyCode() {
  const code = st && st.refCode; if (!code) return;
  try { await navigator.clipboard.writeText(code); }
  catch {
    const el = $('bncode'), sel = getSelection(), rg = document.createRange();
    rg.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(rg);
    let ok = false; try { ok = document.execCommand('copy'); } catch {}
    if (!ok) { setMsg('ref', 'Tidak bisa menyalin otomatis, salin kodenya manual ya.', 'err'); return; }
  }
  setMsg('ref', 'Kode disalin.', 'ok');
}

body.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const a = b.dataset.act;
  if (a === 'claim') claim();
  else if (a === 'redeem') redeem();
  else if (a === 'copy') copyCode();
  else if (a === 'share') navigator.share({ title: 'Neyhra Chat', text: 'Pakai kode referalku ' + st.refCode + ' di Neyhra Chat.', url: location.origin }).catch(() => {});
  else if (a === 'login') openLogin();
  else if (a === 'retry') load(true);
});
body.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'bnin') { e.preventDefault(); redeem(); } });
body.addEventListener('input', e => { if (e.target.id === 'bnin') e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

/* ---------- Kapan menyegarkan ---------- */
window.addEventListener('shell:tab', e => { if (e.detail === 'bonus') load(); });
window.addEventListener('acct', () => { ready = true; if (active()) load(true); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && active()) load(); });
new MutationObserver(() => { if (active() && $('smodal').classList.contains('hide')) load(true); }) // pulih dari Pengaturan (mungkin baru masuk/keluar akun)
  .observe($('smodal'), { attributes: true, attributeFilter: ['class'] });

paintWallet(loadWallet());
ready = aOn || !!window.__acctSeen; render(); // __acctSeen: paintAcct sudah jalan sebelum file ini dimuat (event 'acct' terlewat)
})();
