/* ===== Tab Bonus: klaim harian + kode referal =====
   Dimuat setelah shell.js, sebelum router.js. Semua hadiah dan saldo diatur server (lib/bonus.js + lib/auth.js):
   di sini hanya menampilkan dan memanggil /api/auth/bonus, /claim, /redeem.
   Memakai global index.html: atok, aOn, aApi, saveWallet, loadWallet, paintWallet (let/const global, akses langsung).
   Kejadian: 'shell:tab' (dari Shell.setTab) dan 'acct' (dari paintAcct) menyegarkan halaman ini. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const app = $('app'), body = $('bnbody');
const nf = new Intl.NumberFormat('id-ID');
const active = () => app.dataset.tab === 'bonus';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let st = null;          // keadaan terakhir dari server { refCode, invited, redeemed, ref, daily, coins, gems }
let ready = false;      // status akun (aktif/tidak) sudah diketahui
let failed = '';        // pesan kalau gagal memuat
let busy = false, lastTok = '', lastAt = 0, resetAt = 0, tick = 0;
const msgs = { daily: ['', ''], ref: ['', ''], redeem: ['', ''] }; // [teks, kelas 'ok'|'err']

const SVG = {
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 017.5 4H15"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V3M8 7l4-4 4 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
};

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

function render() {
  clearInterval(tick); tick = 0;
  if (!ready && !aOn) { body.innerHTML = empty('Memuat…'); return; }
  if (!aOn) { body.innerHTML = empty('Bonus belum tersedia', 'Fitur akun belum aktif di server ini, jadi bonus belum bisa dipakai.'); return; }
  if (!atok) { body.innerHTML = empty('Masuk dulu ya', 'Bonus harian dan kode referal tersimpan di akunmu, jadi kamu perlu masuk atau daftar dulu.', '<button class="bn-go" type="button" data-act="login">Masuk / Daftar</button>'); return; }
  if (!st) { body.innerHTML = failed ? empty('Gagal memuat', failed, '<button class="bn-go" type="button" data-act="retry">Coba lagi</button>') : empty('Memuat…'); return; }

  const d = st.daily, total = d.rewards.length;
  const days = d.rewards.map((r, i) => {
    const n = i + 1, done = n <= d.claimedDays, on = !d.claimedToday && n === d.claimDay, next = d.claimedToday && n === d.claimDay && d.claimedDays < total;
    const label = 'Hari ' + n + ': ' + rewardText(r) + (done ? ', sudah diklaim' : on ? ', bisa diklaim sekarang' : '');
    return '<div class="bn-day' + (done ? ' done' : '') + (on ? ' on' : '') + (next ? ' next' : '') + '" role="listitem" aria-label="' + esc(label) + '"' + (on ? ' aria-current="step"' : '') + '>' +
      '<span class="d">' + (next ? 'Besok' : 'Hari ' + n) + '</span><img src="' + icon(r) + '" alt="" draggable="false"><b>+' + amount(r) + '</b></div>';
  }).join('');
  const btn = d.claimedToday
    ? '<button class="bn-btn" type="button" data-act="claim" disabled>Klaim lagi dalam <span id="bncd">' + clock(resetAt - Date.now()) + '</span></button>'
    : '<button class="bn-btn" type="button" data-act="claim">Klaim hari ke-' + d.claimDay + ' · ' + esc(rewardText(d.rewards[d.claimDay - 1])) + '</button>';
  const hint = d.claimedDays > 0 && !d.claimedToday
    ? 'Kamu sudah klaim ' + d.claimedDays + ' hari berturut-turut. Klaim hari ini supaya tidak putus.'
    : 'Masuk tiap hari untuk hadiah makin besar. Kalau ada hari yang terlewat, hitungan mulai lagi dari hari 1. Hari berganti pukul 00.00 WIB.';
  const canShare = typeof navigator.share === 'function';
  const inv = rewardText(st.ref && st.ref.invitee);

  body.innerHTML =
    '<div class="bn-card"><h2>Klaim harian</h2><p class="bn-hint">' + esc(hint) + '</p>' +
      '<div class="bn-days" role="list">' + days + '</div>' + btn + '<p class="bn-msg" data-m="daily" role="status"></p></div>' +
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
    }, 1000);
  }
}

/* ---------- Server ---------- */
const stamp = () => { resetAt = Date.now() + st.daily.resetMs; };
async function fetchState() {
  try {
    const r = await aApi('bonus');
    if (r && r.ok) { st = r; failed = ''; stamp(); saveWallet(r); return true; }
    failed = (r && r.error) || 'Gagal memuat bonus.';
  } catch (e) { failed = e && e.status === 401 ? '' : (e && e.message) || 'Tidak bisa terhubung ke server.'; }
  return false;
}
async function load(force) {
  if (lastTok !== atok) { lastTok = atok; st = null; failed = ''; for (const k in msgs) msgs[k] = ['', '']; }
  if (!aOn || !atok) { st = null; render(); return; }
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
    if (r && r.ok) { st.daily = r.daily; st.coins = r.coins; st.gems = r.gems; stamp(); saveWallet(r); setMsg('daily', '+' + rewardText(r.reward) + ' masuk ke saldomu.', 'ok'); }
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
  else if (a === 'login') $('setbtn').click();
  else if (a === 'retry') load(true);
});
body.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'bnin') { e.preventDefault(); redeem(); } });
body.addEventListener('input', e => { if (e.target.id === 'bnin') e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

/* ---------- Kapan menyegarkan ---------- */
window.addEventListener('shell:tab', e => { if (e.detail === 'bonus') load(); });
window.addEventListener('acct', () => { ready = true; if (active()) load(true); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && active()) load(); });
new MutationObserver(() => { if (active() && $('smodal').classList.contains('hide')) load(true); }) // pulang dari Pengaturan (mungkin baru masuk/keluar akun)
  .observe($('smodal'), { attributes: true, attributeFilter: ['class'] });

paintWallet(loadWallet());
ready = aOn || !!window.__acctSeen; render(); // __acctSeen: paintAcct sudah jalan sebelum file ini dimuat (event 'acct' terlewat)
})();