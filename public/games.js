/* ===== Tab Minigame: hub game + Tebak Angka =====
   Dimuat setelah shell.js (dan bonus.js), sebelum router.js. Semua hasil permainan, hadiah, dan saldo diputuskan server
   (lib/games.js): di sini hanya menampilkan dan memanggil /api/auth/game, /game/start, /game/guess.
   Memakai global index.html: atok, aOn, aApi, saveWallet, loadWallet, paintWallet (let/const global, akses langsung).
   Kejadian: 'shell:tab' (dari Shell.setTab) dan 'acct' (dari paintAcct) menyegarkan halaman ini.

   Menambah game baru: tambah entri di GAMES (ready:true) + fungsi render layarnya, lalu route aksinya di body click handler. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const app = $('app'), body = $('gmbody');
const nf = new Intl.NumberFormat('id-ID');
const active = () => app.dataset.tab === 'games';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SVG = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
  guess: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 115 0c0 1.7-2.5 2-2.5 3.5M12 17h.01"/></svg>',
  pic: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/></svg>',
  chess: '<svg viewBox="0 0 24 24"><circle cx="12" cy="6.8" r="3.1"/><path d="M9.8 9.4C8.5 10.4 7.6 12 7.6 13.8c0 1.2.4 2.3 1.1 3.2l-1.5 2.5c-.2.4.1.9.5.9h8.6c.4 0 .7-.5.5-.9l-1.5-2.5c.7-.9 1.1-2 1.1-3.2 0-1.8-.9-3.4-2.2-4.4"/><path d="M5.5 21.5h13"/></svg>',
  slot: '<svg viewBox="0 0 24 24"><rect x="2.5" y="5" width="19" height="14" rx="3.5"/><path d="M6.5 9.5h3M6.5 12.5h3M6.5 15.5h3"/><circle cx="15.5" cy="10" r="1.6"/><circle cx="15.5" cy="15" r="1.6"/><path d="M6 19v1.8M18 19v1.8"/></svg>',
  soon: '<svg viewBox="0 0 24 24"><path d="M6 12h4M8 10v4M15 13h.01M18 11h.01"/><path d="M17.32 5H6.68a4 4 0 00-3.98 3.59C2.6 9.42 2 14.46 2 16a3 3 0 003 3c1 0 1.5-.5 2-1l1.41-1.41A2 2 0 019.83 16h4.34a2 2 0 011.41.59L17 18c.5.5 1 1 2 1a3 3 0 003-3c0-1.55-.6-6.58-.68-7.26A4 4 0 0017.32 5z"/></svg>'
};
// daftar game. ready:false = kartu "segera hadir" (belum bisa dibuka)
const GAMES = [
  { id: 'guess', ready: true, icon: SVG.guess, title: 'Tebak Angka', desc: 'Tebak angka rahasia 1-100 dalam 7 kali tebakan. Makin cepat, makin banyak coin.' },
  { id: 'pic', ready: true, icon: SVG.pic, title: 'Tebak Gambar', desc: 'Tebak kata atau ungkapan dari gambar teka-teki. Makin sedikit salah, makin banyak coin.' },
  { id: 'chess', ready: true, icon: SVG.chess, title: 'Catur', desc: 'Lawan AI catur: mudah, sedang, atau sulit. Aturan lengkap: rokade, en passant, promosi.' },
  { id: 'slot', ready: true, icon: SVG.slot, title: 'Fruit Slot', desc: 'Slot buah arcade 3x3: combo x7 membuka Bonus Session. Mode Demo gratis pakai virtual point, mode Paid beneran bayar pakai Chip.' },
  { id: 'soon', ready: false, icon: SVG.soon, title: 'Segera hadir', desc: 'Minigame lain lagi disiapkan.' }
];

let ps = null;            // keadaan Tebak Gambar dari server { cfg, daily, total, game, coins, gems }
let st = null;            // keadaan terakhir dari server { cfg, daily, game, coins, gems }
let cs = null;            // keadaan Catur dari server { cfg, daily, game, coins, gems }
let csFail = '';
let chSel = -1;           // kotak catur yang sedang dipilih
let chPromo = null;       // { from, to } -> menunggu pilihan bidak promosi
let chArm = 0;            // konfirmasi dua-tap tombol menyerah
let screen = 'hub';       // 'hub' | id game
let ready = false;        // status akun (aktif/tidak) sudah diketahui
let failed = '';          // pesan kalau gagal memuat
let intro = true;         // true = tampilkan layar pembuka game dulu (aturan + tombol Mulai/Lanjutkan), bukan langsung soalnya
let busy = false, lastTok = '', lastAt = 0;
let msg = ['', ''];       // pesan di bawah input [teks, kelas 'ok'|'err']

const empty = (title, text, btn) => '<div class="gm-empty"><h2>' + esc(title) + '</h2>' + (text ? '<p>' + esc(text) + '</p>' : '') + (btn || '') + '</div>';
const setMsg = (text, cls) => {
  msg = [text || '', cls || ''];
  const el = body.querySelector('.gm-msg');
  if (el) { el.textContent = msg[0]; el.className = 'gm-msg' + (cls ? ' ' + cls : ''); }
};

function hub() {
  const d = st.daily;
  return '<div class="gm-grid">' + GAMES.map(g =>
    '<button class="gm-card' + (g.ready ? '' : ' soon') + '" type="button" data-act="open" data-g="' + g.id + '"' + (g.ready ? '' : ' disabled') + '>' +
      '<span class="ic">' + g.icon + '</span><b>' + esc(g.title) + '</b><span>' + esc(g.desc) + '</span>' +
      (g.id === 'guess' ? '<span class="gm-tag">Hadiah hari ini ' + d.wins + '/' + d.cap + '</span>' : g.id === 'pic' && ps ? '<span class="gm-tag">Hadiah hari ini ' + ps.daily.wins + '/' + ps.daily.cap + '</span>' : g.id === 'chess' && cs ? '<span class="gm-tag">Hadiah hari ini ' + cs.daily.wins + '/' + cs.daily.cap + '</span>' : '') + '</button>'
  ).join('') + '</div>';
}

// Layar pembuka tiap game: ikon, aturan singkat, fakta, status (kalau ada permainan yang belum selesai), lalu tombol. Soal baru terlihat setelah tombol ditekan.
function introHtml(o) {
  return '<div class="gm-intro"><span class="ic">' + o.icon + '</span><h2>' + esc(o.title) + '</h2><p class="gm-hint">' + esc(o.lead) + '</p>' +
    '<div class="gm-facts">' + o.facts.map(f => '<span><b>' + esc(f[0]) + '</b>' + esc(f[1]) + '</span>').join('') + '</div>' +
    '<ol class="gm-how">' + o.steps.map(t => '<li>' + esc(t) + '</li>').join('') + '</ol>' +
    (o.status ? '<p class="gm-resume">' + esc(o.status) + '</p>' : '') +
    '<button class="gm-btn full" type="button" data-act="' + o.act + '">' + esc(o.btn) + '</button>' +
    '<p class="gm-msg' + (msg[1] ? ' ' + msg[1] : '') + '" role="status">' + esc(msg[0]) + '</p></div>';
}

function guessScreen() {
  const g = st.game, d = st.daily, rw = st.cfg.rewards, total = rw.length, capped = d.wins >= d.cap;
  const last = g && g.hist.length ? g.hist[g.hist.length - 1] : null;
  const hist = g ? g.hist.map(h => '<span' + (h.r === 'win' ? ' class="win"' : '') + '>' + h.n + (h.r === 'up' ? ' ↑' : h.r === 'down' ? ' ↓' : ' ✓') + '</span>').join('') : '';
  let main;
  if (intro) {
    const live = g && g.active;
    main = introHtml({ icon: SVG.guess, title: 'Tebak Angka', lead: 'Aku memilih satu angka rahasia dari ' + st.cfg.min + ' sampai ' + st.cfg.max + '. Tebak sebelum kesempatanmu habis.',
      facts: [[String(total), 'kali tebakan'], [st.cfg.min + '-' + st.cfg.max, 'rentang angka'], ['+' + nf.format(rw[0]), 'coin maksimal']],
      steps: ['Ketik satu angka lalu tekan Tebak.', 'Panah ↑ artinya angkanya lebih besar, ↓ lebih kecil.', 'Makin sedikit tebakan, makin banyak coin.'],
      status: live ? 'Ada permainan yang belum selesai (tebakan ke-' + (g.tries + 1) + ' dari ' + total + ').' : '', act: live ? 'play' : 'start', btn: live ? 'Lanjutkan' : (g ? 'Main lagi' : 'Mulai') });
  } else if (g && g.active) {
    const left = total - g.tries;
    main =
      '<h2>Tebak angkanya</h2><p class="gm-hint">Angkanya ada di antara dua angka ini. Panah ↑ berarti angkanya lebih besar dari tebakanmu, ↓ lebih kecil.</p>' +
      '<div class="gm-range"><b>' + g.lo + '</b><i>sampai</i><b>' + g.hi + '</b></div>' +
      '<div class="gm-dots" aria-hidden="true">' + Array.from({ length: total }, (_, i) => '<i' + (i < g.tries ? ' class="used"' : '') + '></i>').join('') + '</div>' +
      '<p class="gm-left">Sisa ' + left + ' tebakan' + (g.tries < rw.length ? ' · menang sekarang +' + nf.format(rw[g.tries]) + ' coin' : '') + '</p>' +
      '<div class="gm-row"><input class="gm-f" id="gmin" type="number" inputmode="numeric" min="' + st.cfg.min + '" max="' + st.cfg.max + '" placeholder="' + g.lo + '-' + g.hi + '" aria-label="Tebakanmu" autocomplete="off" enterkeyhint="go">' +
      '<button class="gm-btn" type="button" data-act="guess">Tebak</button></div>' +
      '<p class="gm-msg' + (msg[1] ? ' ' + msg[1] : '') + '" role="status">' + esc(msg[0]) + '</p>' +
      (hist ? '<div class="gm-hist">' + hist + '</div>' : '');
  } else if (g) { // selesai: menang atau kalah
    const won = g.won, prize = g.reward;
    main = '<h2>Tebak angkanya</h2><div class="gm-result">' + (won
      ? '<h3>Benar! Angkanya ' + (last ? last.n : '') + '</h3><p>Ketemu dalam ' + g.tries + ' tebakan.</p>' +
        (prize ? '<div class="gm-prize"><img src="/coin.svg" alt="">+' + nf.format(prize) + ' coin</div>'
               : '<p>Hadiah harian sudah habis (' + d.wins + '/' + d.cap + '), jadi kali ini tanpa coin. Hadiah kembali besok pukul 00.00 WIB.</p>')
      : '<h3>Yah, belum berhasil</h3><p>Angka rahasianya ' + g.secret + '. Coba lagi, bagi dua rentangnya tiap tebakan supaya selalu ketemu dalam ' + total + ' kali.</p>') +
      '</div>' + (hist ? '<div class="gm-hist">' + hist + '</div>' : '') +
      '<button class="gm-btn full" type="button" data-act="start">Main lagi</button><p class="gm-msg' + (msg[1] ? ' ' + msg[1] : '') + '" role="status">' + esc(msg[0]) + '</p>';
  } else {
    main = '<h2>Tebak Angka</h2><p class="gm-hint">Aku memilih satu angka rahasia dari ' + st.cfg.min + ' sampai ' + st.cfg.max + '. Kamu punya ' + total + ' kali tebakan, dan tiap kali kujawab angkanya lebih besar atau lebih kecil.</p>' +
      '<button class="gm-btn full" type="button" data-act="start">Mulai</button><p class="gm-msg' + (msg[1] ? ' ' + msg[1] : '') + '" role="status">' + esc(msg[0]) + '</p>';
  }
  const table = rw.map((c, i) => '<div>Tebakan ke-' + (i + 1) + '<b><img src="/coin.svg" alt="">' + nf.format(c) + '</b></div>').join('');
  return '<button class="gm-back" type="button" data-act="hub">' + SVG.back + 'Semua game</button>' +
    '<div class="gm-panel">' + main + '</div>' +
    '<div class="gm-info"><h3>Hadiah menang</h3><div class="gm-rw">' + table + '</div>' +
    '<p class="gm-cap">' + (capped ? 'Hadiah hari ini sudah habis (' + d.wins + '/' + d.cap + '). Kamu tetap bisa main buat latihan, hadiah kembali besok pukul 00.00 WIB.'
      : 'Maksimal ' + d.cap + ' kemenangan berhadiah per hari (sekarang ' + d.wins + '/' + d.cap + '). Hari berganti pukul 00.00 WIB.') + '</p></div>';
}

function picScreen() {
  const back = '<button class="gm-back" type="button" data-act="hub">' + SVG.back + 'Semua game</button>';
  if (!ps) return back + '<div class="gm-panel"><h2>Tebak Gambar</h2><p class="gm-hint">' + esc(picFail || 'Memuat…') + '</p>' +
    (picFail ? '<button class="gm-btn full" type="button" data-act="open" data-g="pic">Coba lagi</button>' : '') + '</div>';
  const g = ps.game, d = ps.daily, capped = d.wins >= d.cap, c = ps.cfg;
  const msgEl = '<p class="gm-msg' + (msg[1] ? ' ' + msg[1] : '') + '" role="status">' + esc(msg[0]) + '</p>';
  const slots = g ? '<div class="gm-pat" aria-label="Jawaban terdiri dari ' + g.pattern.length + ' kata, ' + g.pattern.reduce((a, b) => a + b, 0) + ' huruf">' +
    g.pattern.map(n => '<span>' + '<i></i>'.repeat(n) + '</span>').join('') + '</div>' : '';
  const hist = g && g.hist.length ? '<div class="gm-hist">' + g.hist.map((h, i) => '<span' + (g.won && i === g.hist.length - 1 ? ' class="win"' : '') + '>' + esc(h.t) + (g.won && i === g.hist.length - 1 ? ' ✓' : ' ✗') + '</span>').join('') + '</div>' : '';
  const img = g ? '<div class="gm-picbox"><img class="gm-pic" src="' + esc(g.img) + '" alt="Gambar teka-teki" referrerpolicy="no-referrer" decoding="async"><p class="gm-picerr hide">Gambar gagal dimuat. Kamu bisa melewati soal ini.</p></div>' : '';
  let main;
  if (intro) {
    const live = g && g.active;
    main = introHtml({ icon: SVG.pic, title: 'Tebak Gambar', lead: 'Lihat gambar teka-teki, lalu tebak kata atau ungkapan yang dimaksud.',
      facts: [[String(c.tries), 'kali kesempatan'], [nf.format(ps.total), 'soal'], ['+' + c.base, 'coin maksimal']],
      steps: ['Gambar baru muncul setelah kamu menekan tombol di bawah.', 'Jumlah huruf jawaban ditampilkan sebagai kotak kosong.', 'Buntu? Buka petunjuk (hadiah jadi setengah) atau lewati soalnya.'],
      status: live ? 'Ada soal yang belum selesai (' + g.tries + ' dari ' + c.tries + ' kesempatan terpakai).' : '', act: live ? 'play' : 'pstart', btn: live ? 'Lanjutkan' : (g ? 'Soal berikutnya' : 'Mulai') });
  } else if (g && g.active) {
    const left = c.tries - g.tries;
    main = '<h2>Tebak gambarnya</h2><p class="gm-hint">Apa kata atau ungkapan yang dimaksud gambar ini?</p>' + img + slots +
      '<div class="gm-dots" aria-hidden="true">' + Array.from({ length: c.tries }, (_, i) => '<i' + (i < g.tries ? ' class="used"' : '') + '></i>').join('') + '</div>' +
      '<p class="gm-left">Sisa ' + left + ' kesempatan · menang sekarang +' + nf.format(g.prize) + ' coin</p>' +
      (g.hint ? '<p class="gm-clue"><b>Petunjuk:</b> ' + esc(g.clue || '') + '</p>' : '') +
      '<div class="gm-row"><input class="gm-f gm-text" id="gmpin" type="text" maxlength="60" placeholder="Jawabanmu" aria-label="Jawabanmu" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go">' +
      '<button class="gm-btn" type="button" data-act="pguess">Jawab</button></div>' + msgEl + hist +
      '<div class="gm-acts">' + (g.hasClue && !g.hint ? '<button class="gm-ghost" type="button" data-act="phint">Buka petunjuk (hadiah jadi setengah)</button>' : '') +
      '<button class="gm-ghost" type="button" data-act="pskip">Lewati soal</button></div>';
  } else if (g) {
    main = '<h2>Tebak gambarnya</h2>' + img + '<div class="gm-result">' + (g.won
      ? '<h3>Benar! ' + esc(g.answer) + '</h3><p>' + g.tries + ' kali menjawab.</p>' +
        (g.reward ? '<div class="gm-prize"><img src="/coin.svg" alt="">+' + nf.format(g.reward) + ' coin</div>'
                  : '<p>Hadiah harian sudah habis (' + d.wins + '/' + d.cap + '), jadi kali ini tanpa coin. Hadiah kembali besok pukul 00.00 WIB.</p>')
      : '<h3>Yah, kesempatan habis</h3><p>Jawabannya: <b>' + esc(g.answer) + '</b></p>') +
      (g.clue ? '<p>' + esc(g.clue) + '</p>' : '') + '</div>' + hist +
      '<button class="gm-btn full" type="button" data-act="pstart">Soal berikutnya</button>' + msgEl;
  } else {
    main = '<h2>Tebak Gambar</h2><p class="gm-hint">Lihat gambar teka-teki, lalu tebak kata atau ungkapan yang dimaksud. Kamu punya ' + c.tries + ' kali kesempatan per soal. Ada ' + nf.format(ps.total) + ' soal.</p>' +
      '<button class="gm-btn full" type="button" data-act="pstart">Mulai</button>' + msgEl;
  }
  return back + '<div class="gm-panel">' + main + '</div>' +
    '<div class="gm-info"><h3>Hadiah menang</h3><p class="gm-cap">Benar di jawaban pertama +' + c.base + ' coin, dikurangi 5 coin tiap jawaban salah (paling sedikit ' + c.min + '). Membuka petunjuk memotong hadiah soal itu jadi setengah. ' +
    (capped ? 'Hadiah hari ini sudah habis (' + d.wins + '/' + d.cap + '). Kamu tetap bisa main buat latihan, hadiah kembali besok pukul 00.00 WIB.'
      : 'Maksimal ' + d.cap + ' kemenangan berhadiah per hari (sekarang ' + d.wins + '/' + d.cap + '). Hari berganti pukul 00.00 WIB.') + '</p></div>';
}

/* ---------- Catur ---------- */
// bidak = glif Unicode penuh (digamam dua-duanya), warnanya lewat CSS .ch-p.w / .ch-p.b
const CH_G = { k: '\u265A', q: '\u265B', r: '\u265C', b: '\u265D', n: '\u265E', p: '\u265F' };
const CH_NAME = { k: 'raja', q: 'ratu', r: 'benteng', b: 'gajah', n: 'kuda', p: 'pion' };
const CH_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const chIsW = p => p >= 'A' && p <= 'Z';
const chLvName = lv => (cs && cs.cfg && cs.cfg.levels && cs.cfg.levels[lv] ? cs.cfg.levels[lv].name : ({ 1: 'Mudah', 2: 'Sedang', 3: 'Sulit' }[lv] || lv));
const CH_END = { mate: 'skakmat', stale: 'pat (tidak ada langkah sah, tidak skak)', 50: 'aturan 50 langkah', rep: 'posisi berulang 3 kali', material: 'material tidak cukup untuk skakmat', resign: 'menyerah' };

function chessScreen() {
  const back = '<button class="gm-back" type="button" data-act="hub">' + SVG.back + 'Semua game</button>';
  if (!cs) return back + '<div class="gm-panel"><h2>Catur</h2><p class="gm-hint">' + esc(csFail || 'Memuat…') + '</p>' +
    (csFail ? '<button class="gm-btn full" type="button" data-act="open" data-g="chess">Coba lagi</button>' : '') + '</div>';
  const g = cs.game, d = cs.daily, lv = cs.cfg.levels;
  const msgEl = '<p class="gm-msg' + (msg[1] ? ' ' + msg[1] : '') + '" role="status">' + esc(msg[0]) + '</p>';

  // layar pembuka: aturan + pilihan tingkat (+ lanjutkan kalau ada permainan berjalan)
  if (intro || !g) {
    const live = g && g.active;
    const cc = chChars();
    if (chOpp && !cc.some(c => c.id === chOpp)) chOpp = '';   // karakter pilihan tersimpan sudah tidak punya chess: true
    const oppPick = cc.length ? '<div class="ch-opp"><span class="ch-opp-t">Lawan (pilih dulu sebelum mulai)</span><div class="ch-opp-l" role="radiogroup" aria-label="Pilih lawan">' +
      '<button type="button" class="ch-oc' + (chOpp ? '' : ' on') + '" role="radio" aria-checked="' + (!chOpp) + '" data-act="copp" data-id=""><span class="ch-oa ai">AI</span><b>Biasa</b></button>' +
      cc.map(c => '<button type="button" class="ch-oc' + (chOpp === c.id ? ' on' : '') + '" role="radio" aria-checked="' + (chOpp === c.id) + '" data-act="copp" data-id="' + esc(c.id) + '"><span class="ch-oa"><img src="' + esc(c.avatar || '') + '" alt="" referrerpolicy="no-referrer"></span><b>' + esc(c.name) + '</b></button>').join('') +
      '</div></div>' : '';
    const lvls = Object.entries(lv).map(([k, v]) =>
      '<button class="ch-lvl" type="button" data-act="cstart" data-lv="' + k + '"><span><b>' + esc(v.name) + '</b>' +
      '<small>' + (k === '1' ? 'AI sering ngawur, cocok buat pemanasan.' : k === '2' ? 'AI jago sedikit, mikir 2 langkah.' : 'AI jago, mikir 3 langkah. Berani?') + '</small></span><em>+' + nf.format(v.prize) + ' coin</em></button>'
    ).join('');
    return back + '<div class="gm-panel">' +
      '<div class="gm-intro"><span class="ic">' + SVG.chess + '</span><h2>Catur</h2>' +
      '<p class="gm-hint">Kamu main putih (bawah), lawanmu main hitam. ' + (cc.length ? 'Pilih lawan: AI biasa, atau karakter yang akan mengomentari permainanmu. ' : '') + 'Kotak yang boleh dituju langsung ditandai server, jadi tidak perlu hafal aturannya.</p>' +
      '<div class="gm-facts"><span><b>3</b>tingkat kesulitan</span><span><b>' + nf.format(lv[1].prize) + '-' + nf.format(lv[3].prize) + '</b>coin per menang</span><span><b>40%</b>hadiah kalau seri</span></div>' +
      '<ol class="gm-how">' + (cc.length ? '<li>Pilih lawan (AI biasa atau karakter). Langkah tetap dihitung engine, karakter hanya berkomentar.</li>' : '') + '<li>Pilih tingkat kesulitan untuk mulai.</li><li>Ketuk bidakmu, lalu ketuk kotak tujuan (ditandai titik).</li><li>Lawan membalas setelah mikir sebentar (kadang dia mengoceh, kalau kamu main lawan karakter). Skakmat lawanmu untuk menang!</li></ol>' +
      (live ? '<p class="gm-resume">Ada permainan ' + esc(chLvName(g.level)) + ' yang belum selesai.</p><div class="gm-row"><button class="gm-btn" type="button" data-act="play">Lanjutkan</button><button class="gm-ghost" type="button" data-act="chnew">Main baru</button></div>' : '') +
      oppPick + '<div class="ch-lvls' + (live ? ' ch-lvls-dim' : '') + '">' + lvls + '</div>' + msgEl + '</div></div>' +
      '<div class="gm-info"><h3>Cara main</h3><p class="gm-cap">Aturan standar lengkap: rokade, en passant, promosi pion, skak, pat, aturan 50 langkah, dan pengulangan posisi. Menang dapat coin sesuai tingkat (seri 40%, paling sedikit ' + nf.format(5) + '), maksimal ' + d.cap + ' kemenangan berhadiah per hari (sekarang ' + d.wins + '/' + d.cap + '). Tidak ada undo: pikirkan dulu!</p></div>';
  }

  // papan
  const yourTurn = g.active && g.turn === 'w';
  const thinking = g.active && !yourTurn; // papan tengah (cmove): lawan sedang mikir — turn 'b' dari server cuma terjadi selama jeda ini
  let board = '<div class="ch-bwrap"><div class="ch-ranks" aria-hidden="true">' + [8, 7, 6, 5, 4, 3, 2, 1].map(n => '<span>' + n + '</span>').join('') + '</div><div class="ch-mid"><div class="ch-board">';
  for (let i = 0; i < 64; i++) {
    const p = g.board[i], cls = ['ch-sq', ((i >> 3) + (i & 7)) % 2 ? 'ch-d' : 'ch-l']; // semua kelas diawali ch-: kelas polos seperti .dot sudah dipakai global di index.html (titik status berkedip) dan merusak papan
    if (g.last && (g.last.f === i || g.last.t === i)) cls.push('ch-last');
    if (chSel === i) cls.push('ch-sel');
    if (g.check === i) cls.push('ch-chk');
    const tos = chSel >= 0 && g.moves && g.moves[chSel] || [];
    if (tos.includes(i)) cls.push(p !== '.' ? 'ch-cap' : 'ch-dot');
    const name = p !== '.' ? CH_NAME[p.toLowerCase()] + ' ' + (chIsW(p) ? 'putih' : 'hitam') : 'kosong';
    board += '<button type="button" class="' + cls.join(' ') + '" data-act="csq" data-i="' + i + '" aria-label="' + sq2name(i) + ', ' + name + '"' + (yourTurn ? '' : ' disabled') + '>' +
      (p !== '.' ? '<span class="ch-p ' + (chIsW(p) ? 'ch-w' : 'ch-b') + '" aria-hidden="true">' + CH_G[p.toLowerCase()] + '</span>' : '') + '</button>';
  }
  board += '</div><div class="ch-files" aria-hidden="true">' + 'abcdefgh'.split('').map(f => '<span>' + f + '</span>').join('') + '</div></div></div>';

  // material yang tertangkap (tampil sebagai glif + selisih poin)
  const capStr = (arr, whitePieces) => arr.slice().sort((a, b) => CH_VAL[b.toLowerCase()] - CH_VAL[a.toLowerCase()]).map(p => CH_G[p.toLowerCase()]).join('');
  const matW = g.capsW.reduce((s, p) => s + CH_VAL[p.toLowerCase()], 0), matB = g.capsB.reduce((s, p) => s + CH_VAL[p.toLowerCase()], 0);
  const diff = matW - matB;
  const caps = '<div class="ch-caps"><span class="ch-cp"><i>' + capStr(g.capsW) + '</i>' + (diff > 0 ? '<b>+' + diff + '</b>' : '') + '</span>' +
    '<span class="ch-turn' + (thinking ? ' is-think' : '') + '">' + (g.active ? (yourTurn ? 'Giliranmu' : ((g.opp && oppOf(g.opp) ? oppOf(g.opp).name : 'AI') + ' mikir…')) : 'Selesai') + (g.check >= 0 ? ' · skak!' : '') + '</span>' +
    '<span class="ch-cp ai"><i>' + capStr(g.capsB) + '</i>' + (diff < 0 ? '<b>+' + (-diff) + '</b>' : '') + '</span></div>';

  // daftar langkah (berpasangan: putih hitam)
  const pairs = [];
  for (let i = 0; i < g.hist.length; i += 2) pairs.push('<div class="ch-mv"><span>' + (i / 2 + 1) + '.</span><span>' + esc(g.hist[i]) + '</span><span>' + esc(g.hist[i + 1] || '') + '</span></div>');

  // hasil
  const r = g.result;
  const result = !r ? '' : '<div class="gm-result">' +
    (r.won === 'w' ? '<h3>Menang!</h3><p>' + esc(CH_END[r.reason] || r.reason) + ' melawan AI ' + esc(chLvName(g.level)) + '.</p>' +
      (g.reward ? '<div class="gm-prize"><img src="/coin.svg" alt="">+' + nf.format(g.reward) + ' coin</div>'
        : '<p>Hadiah harian sudah habis (' + d.wins + '/' + d.cap + '), jadi kali ini tanpa coin. Hadiah kembali besok pukul 00.00 WIB.</p>')
      : r.won === 'd' ? '<h3>Seri</h3><p>' + esc(CH_END[r.reason] || r.reason) + '.</p>' +
        (g.reward ? '<div class="gm-prize"><img src="/coin.svg" alt="">+' + nf.format(g.reward) + ' coin</div>' : '')
        : '<h3>Kalah</h3><p>' + esc(CH_END[r.reason] || r.reason) + '.</p>') +
    '</div><button class="gm-btn full" type="button" data-act="chnew">Main lagi</button>';

  // pilihan bidak promosi (muncul saat pion mencapai kotak terakhir)
  const promo = chPromo ? '<div class="ch-promo"><span>Pionnya jadi apa?</span>' +
    ['Q', 'R', 'B', 'N'].map(x => '<button type="button" class="ch-pr" data-act="cpromo" data-p="' + x + '" aria-label="Promosi ' + CH_NAME[x.toLowerCase()] + '">' + CH_G[x.toLowerCase()] + '</button>').join('') +
    '<button type="button" class="ch-prx" data-act="cancelpromo">Batal</button></div>' : '';

  return back + '<div class="gm-panel">' +
    '<h2>Catur <small class="ch-lv">' + esc(chLvName(g.level)) + '</small></h2>' +
    caps + (g.opp && oppOf(g.opp) ? '<div class="ch-say" id="chsay" aria-live="polite">' + chSayInner() + '</div>' : '') + board + promo + msgEl +
    (g.active ? '<div class="ch-acts"><button class="gm-ghost" type="button" data-act="cresign"' + (chArm ? ' data-arm="1"' : '') + '>' + (chArm ? 'Tap lagi: menyerah' : 'Menyerah') + '</button></div>' : '') +
    result + '</div>' +
    '<div class="gm-info"><h3>Langkah (' + g.hist.length + ')</h3>' + (pairs.length ? '<div class="ch-hist">' + pairs.join('') + '</div>' : '<p class="gm-cap">Belum ada langkah.</p>') +
    '<p class="gm-cap">Menang +' + nf.format(lv[String(g.level)].prize) + ' coin (seri 40%). Maksimal ' + d.cap + ' kemenangan berhadiah per hari (sekarang ' + d.wins + '/' + d.cap + ').</p></div>';
}
const sq2name = i => 'abcdefgh'[i & 7] + (8 - (i >> 3));

function render() {
  if (screen !== 'chess') chVoiceStop();
  if (!ready && !aOn) { body.innerHTML = empty('Memuat…'); return; }
  if (!aOn) { body.innerHTML = empty('Minigame belum tersedia', 'Fitur akun belum aktif di server ini, jadi coin hasil main belum bisa disimpan.'); return; }
  if (!atok) { body.innerHTML = empty('Masuk dulu ya', 'Coin hasil main tersimpan di akunmu, jadi kamu perlu masuk atau daftar dulu.', '<button class="gm-btn" type="button" data-act="login">Masuk / Daftar</button>'); return; }
  if (screen === 'slot' && window.SLOT) { SLOT.render(body); return; } // Fruit Slot punya keadaan & pemuatan sendiri (public/slot.js)
  if (!st) { body.innerHTML = failed ? empty('Gagal memuat', failed, '<button class="gm-btn" type="button" data-act="retry">Coba lagi</button>') : empty('Memuat…'); return; }
  body.innerHTML = screen === 'guess' ? guessScreen() : screen === 'pic' ? picScreen() : screen === 'chess' ? chessScreen() : hub();
  if (chPlan) { const p = chPlan; chPlan = null; if (screen === 'chess' && body.querySelector('.ch-board')) chPlay(p); } // animasi langkah (dibuat di cmove)
  if (!intro && screen === 'pic' && ps && ps.game && ps.game.active && active() && $('gmpin') && !msg[1]) $('gmpin').focus({ preventScroll: true });
  if (intro) { /* layar pembuka: jangan fokus ke input (keyboard HP jangan langsung muncul) */ }
  else if (screen === 'guess' && st.game && st.game.active && active()) { const i = $('gmin'); if (i && !msg[1]) i.focus({ preventScroll: true }); }
  else if (screen === 'guess' && $('gmin') && active()) $('gmin').focus({ preventScroll: true });
}

/* ---------- Server ---------- */
const nqToast = r => { if (r && Array.isArray(r.nq)) r.nq.forEach((t, i) => setTimeout(() => toast(t), 500 + i * 2300)); }; // misi selesai / piala baru (lib/quests.js)
async function call(path, data) {
  const r = await aApi(path, data);
  if (r && r.ok) { st = r; failed = ''; saveWallet(r); nqToast(r); return true; }
  return false;
}
let picFail = '';
async function callP(path, data) {
  const r = await aApi(path, data);
  if (r && r.ok) { ps = r; picFail = ''; saveWallet(r); nqToast(r); return true; }
  return false;
}
async function fetchPic() {
  try { if (!(await callP('pic'))) picFail = 'Gagal memuat Tebak Gambar.'; }
  catch (e) { picFail = e && e.status === 401 ? '' : (e && e.message) || 'Tidak bisa terhubung ke server.'; }
}
async function callC(path, data) {
  const r = await aApi(path, data);
  if (r && r.ok) { cs = r; csFail = ''; saveWallet(r); nqToast(r); return true; }
  return false;
}
async function fetchChess() {
  try { if (!(await callC('chess'))) csFail = 'Gagal memuat catur.'; }
  catch (e) { csFail = e && e.status === 401 ? '' : (e && e.message) || 'Tidak bisa terhubung ke server.'; }
}
async function fetchState() {
  const pp = fetchPic(); // Tebak Gambar dimuat berdampingan; kalau gagal, hanya kartunya yang tidak menampilkan progres
  const cc = fetchChess(); // Catur juga
  let ok = false;
  try { ok = await call('game'); if (!ok) failed = 'Gagal memuat minigame.'; }
  catch (e) { failed = e && e.status === 401 ? '' : (e && e.message) || 'Tidak bisa terhubung ke server.'; }
  await pp; await cc;
  return ok;
}
async function load(force) {
  if (lastTok !== atok) { lastTok = atok; st = null; ps = null; cs = null; csFail = ''; picFail = ''; failed = ''; screen = 'hub'; msg = ['', '']; chSel = -1; chPromo = null; }
  if (!aOn || !atok) { st = null; ps = null; cs = null; render(); return; }
  if (busy || (!force && st && Date.now() - lastAt < 3000)) { render(); return; }
  busy = true; if (!st) render();
  await fetchState();
  lastAt = Date.now(); busy = false; render();
}

async function start() {
  if (busy) return; busy = true; msg = ['', ''];
  const b = body.querySelector('[data-act="start"]'); if (b) b.disabled = true;
  try { await call('game/start'); } catch (e) { msg = [e.message || 'Gagal memulai, coba lagi.', 'err']; }
  busy = false; render();
}

async function guess() {
  if (busy) return;
  const inp = $('gmin'), n = inp ? Number(inp.value) : NaN, g = st && st.game;
  if (!g || !g.active) return;
  if (inp && inp.value.trim() === '') { setMsg('Isi angka tebakanmu dulu.', 'err'); inp.focus(); return; }
  if (!Number.isInteger(n) || n < g.lo || n > g.hi) { setMsg('Tebak angka bulat antara ' + g.lo + ' dan ' + g.hi + '.', 'err'); inp.focus(); inp.select(); return; }
  busy = true;
  const b = body.querySelector('[data-act="guess"]'); if (b) b.disabled = true;
  try {
    if (await call('game/guess', { n })) {
      const r = st.result;
      msg = r === 'up' ? [n + ' terlalu kecil. Angkanya lebih besar ↑', ''] : r === 'down' ? [n + ' terlalu besar. Angkanya lebih kecil ↓', ''] : ['', ''];
      if (r === 'win' && st.game && st.game.reward) saveWallet(st);
    }
  } catch (e) {
    msg = [e.message || 'Gagal mengirim tebakan, coba lagi.', 'err'];
    if (e.status === 409) await fetchState(); // permainan berubah (mis. dari perangkat lain): ikut keadaan server
  }
  busy = false; render();
}

async function pic(path, data, errText) {
  if (busy) return; busy = true;
  body.querySelectorAll('.gm-btn,.gm-ghost').forEach(b => { b.disabled = true; });
  try { await callP(path, data); if (path === 'pic/start') msg = ['', '']; }
  catch (e) { msg = [e.message || errText, 'err']; if (e.status === 409) await fetchPic(); }
  busy = false; render();
}
async function pguess() {
  if (busy) return;
  const inp = $('gmpin'), t = inp ? inp.value.trim() : '';
  if (!ps || !ps.game || !ps.game.active) return;
  if (!t) { setMsg('Isi jawabanmu dulu.', 'err'); if (inp) inp.focus(); return; }
  busy = true;
  body.querySelectorAll('.gm-btn,.gm-ghost').forEach(b => { b.disabled = true; });
  try {
    if (await callP('pic/guess', { t })) msg = ps.result === 'wrong' ? ['Belum tepat, coba lagi.', 'err'] : ['', ''];
  } catch (e) {
    msg = [e.message || 'Gagal mengirim jawaban, coba lagi.', 'err'];
    if (e.status === 409) await fetchPic();
  }
  busy = false; render();
  const i = $('gmpin'); if (i && active()) { i.value = ''; i.focus({ preventScroll: true }); }
}

/* ---------- Catur: aksi ---------- */
async function cstart(lv) {
  if (busy) return; busy = true; msg = ['', '']; let started = false;
  body.querySelectorAll('.ch-lvl,.gm-btn,.gm-ghost').forEach(b => { b.disabled = true; });
  try {
    if (await callC('chess/start', { level: Number(lv), ...(chOpp && chChars().some(c => c.id === chOpp) ? { opp: chOpp } : {}) })) { started = true; intro = false; chSel = -1; chPromo = null; msg = ['', 'Kamu putih. Mulai dengan melangkah pion dua kotak (e2-e4 misalnya).']; }
  } catch (e) { msg = [e.message || 'Gagal memulai, coba lagi.', 'err']; }
  chSayTok++; chSaying = false; busy = false; render();
  if (started) csay(); // sapaan pembuka dari lawan (kalau dia mau)
}
/* ---------- Catur: lawan karakter ----------
   Karakter yang di char/<id>.js punya `chess: true` muncul di pilihan "Lawan" (daftar karakter dari /api/chars, kolom `chess`). Langkahnya tetap dari
   engine di server; karakternya hanya sesekali berkomentar (server yang memutuskan bicara atau tidak, jadi kebanyakan panggilan selesai cepat).
   Komentar diminta lewat /api/auth/chess/say BEGITU langkah diterima — paralel dengan jeda "mikir" AI (lihat cmove) — jadi biasanya sudah siap
   sekitar saat bidak AI meluncur, dan teks + suaranya selalu muncul bersamaan. */
let chOpp = (() => { try { return localStorage.getItem('chessOpp') || ''; } catch { return ''; } })();
let chSaying = false, chSayTok = 0;
const chUnlocked = () => { try { return localStorage.getItem('chessu') === '1'; } catch { return false; } }; // kode rahasia ke Reze (tryChess di index.html); pagar UI, bukan keamanan
const chChars = () => !chUnlocked() ? [] : (typeof allChars !== 'undefined' && Array.isArray(allChars) ? allChars : []).filter(c => c.chess);
const oppOf = id => (typeof allChars !== 'undefined' && Array.isArray(allChars) ? allChars : []).find(c => c.id === id) || null;
let chPendingAudio = null; // suara yang diblokir autoplay browser (bubble menampilkan tombol "Putar suara")
let chAnimKey = ''; // bubble hanya beranimasi saat isinya BARU. Papan digambar ulang tiap ketukan (pilih bidak), tanpa ini bubble ikut "melompat" tiap kali.
function chSayInner() {
  const g = cs && cs.game, oc = g && g.opp ? oppOf(g.opp) : null; if (!oc) return '';
  const av = '<img class="ch-sa" src="' + esc(oc.avatar || '') + '" alt="" referrerpolicy="no-referrer">';
  const still = k => { const s = k === chAnimKey; chAnimKey = k; return s ? ' still' : ''; };
  if (chSaying) return av + '<div class="ch-sb typing' + still('T' + chSayTok) + '" aria-label="' + esc(oc.name) + ' sedang mengetik"><i></i><i></i><i></i></div>';
  const replay = chPendingAudio ? '<button type="button" class="ch-play" data-act="cvoice">Putar suara</button>' : '';
  if (g.say) return av + '<div class="ch-sb' + still('S' + g.say) + '"><b>' + esc(oc.name) + '</b><p>' + esc(g.say) + '</p>' + replay + '</div>';
  return av + '<div class="ch-sb idle"><b>' + esc(oc.name) + '</b><p>Lawanmu kali ini.</p></div>';
}
const chSayPaint = () => { const el = $('chsay'); if (el) el.innerHTML = chSayInner(); };  // hanya kotak ocehan yang digambar ulang, supaya animasi bidak tidak terputus
async function csay(revealAt = 0) {
  const g = cs && cs.game; if (!g || !g.opp) return;
  const tok = ++chSayTok, t = setTimeout(() => { if (tok === chSayTok) { chSaying = true; chSayPaint(); } }, 800); // titik mengetik baru muncul kalau server memang sedang membuat komentar
  // suara ikut pengaturan bawaan chat (switch Voice, bahasa JP/ID, suara karakter, kecepatan); kalau voice mati, server tidak membuat teks suara
  const vo = chVoiceOn() ? { on: true, lang: typeof voiceLang !== 'undefined' && voiceLang === 'id' ? 'id' : 'jp' } : { on: false };
  let r = null;
  try { r = await aApi('chess/say', { voice: vo }); } catch {}
  clearTimeout(t);
  if (tok !== chSayTok) { chSaying = false; return; } // pemain sudah melangkah lagi (main cepat): ocehan ini basi, dibuang supaya tidak menumpuk
  if (!(r && r.ok && typeof r.say === 'string' && r.say)) { chSaying = false; chSayPaint(); return; }
  // audionya disiapkan SEKARANG (masih tumpang tindih dengan sisa jeda mikir): teks dan suara muncul BERSAMAAN, walaupun mikirnya lama
  const audio = vo.on && typeof r.vn === 'string' && r.vn ? await chTTS(g.opp, r.vn, tok) : null;
  const wait = revealAt - Date.now();
  if (wait > 0) await chSleep(wait); // komentar menggambarkan posisi SETELAH langkah AI: jangan mendahului bidaknya
  if (tok !== chSayTok) { chSaying = false; return; }
  chSaying = false;
  if (!(cs && cs.game)) return;
  // Ocehan sebelumnya masih BUNYI? Tunggu selesai (maks 15 dtk) — pemain yang main cepat tidak lagi memotong lawannya di
  // tengah kalimat; ocehan baru (termasuk komentar penutup atau sapaan permainan baru) menggantikan setelah kalimatnya habis.
  await chWaitVoice();
  if (tok !== chSayTok || !(cs && cs.game)) return; // selagi menunggu pemain melangkah lagi / permainan berubah: buang ocehan ini
  // Teks SELALU tampil dan suaranya (kalau ada) diputar bersamaan: teks baru dipasang begitu audio benar-benar mulai bunyi.
  // Kalau suaranya tidak ada (voice mati / TTS gagal) teks langsung tampil; kalau diblokir autoplay browser, teks tampil + tombol "Putar suara".
  chPendingAudio = null;
  if (audio && screen === 'chess') {
    const ok = await chVoicePlay(audio);
    if (tok !== chSayTok || !(cs && cs.game)) return; // ada ocehan/permainan baru selagi menunggu suara mulai
    cs.game.say = r.say;
    if (!ok) chPendingAudio = audio;
  } else cs.game.say = r.say;
  chSayPaint();
}

/* ---------- Catur: suara lawan ----------
   Memakai pengaturan suara chat apa adanya: switch Voice + kode voice (von/vcode), bahasa (voiceLang), suara karakter (voiceKeyOf), kecepatan (vSpeed),
   dan endpoint /api/tts yang sama. Kalau voice mati atau kode belum benar, tidak ada suara. Suara gagal tidak mengganggu permainan.
   Audionya DISIAPKAN dulu (chTTS) lalu diputar (chVoicePlay — JANGAN dinamai chPlay: itu nama fungsi animasi bidak di bawah, tabrakan nama bikin suara tidak pernah jalan) SEKALIGUS dengan teks komentarnya — teks dan suara selalu muncul bareng. */
let chAudio = null, chAudioUrl = '';
const chVoiceOn = () => typeof voiceOn !== 'undefined' && voiceOn && typeof vcode !== 'undefined' && !!vcode;
function chVoiceStop() { try { if (chAudio) { chAudio.pause(); chAudio.onended = null; } if (chAudioUrl) URL.revokeObjectURL(chAudioUrl); } catch {} chAudio = null; chAudioUrl = ''; }
function chWaitVoice() { /* tunggu ocehan yang sedang diputar habis dulu (pengaman 15 dtk): ocehan berikutnya tidak memotong kalimat lawan di tengah. Selesai menunggu juga kalau audionya diganti/dihentikan (chVoiceStop) atau layar Catur ditutup. */
  return new Promise(res => {
    const el = chAudio;
    if (!el || el.paused || el.ended) return res();
    let iv = 0, tm = 0;
    const done = () => { if (iv) clearInterval(iv); if (tm) clearTimeout(tm); el.removeEventListener('ended', done); res(); };
    iv = setInterval(() => { if (chAudio !== el || el.paused || el.ended) done(); }, 100);
    el.addEventListener('ended', done);
    tm = setTimeout(done, 15000);
  });
}
async function chTTS(charId, vn, tok) {
  if (!charId || !vn || !chVoiceOn() || typeof post !== 'function') return null;
  for (let attempt = 0; attempt < 2; attempt++) { // satu kali coba ulang: TTS kadang gagal sesaat (batas laju / jaringan), padahal suara harus selalu ada
    try {
      const ab = await (await post('/api/tts', { char: charId, text: vn, voice: typeof voiceKeyOf === 'function' ? voiceKeyOf(charId) : undefined }, { 'x-voice-code': vcode })).arrayBuffer();
      if (tok !== chSayTok) return null; // sudah ada ocehan lebih baru: jangan pakai yang basi
      return new Blob([ab], { type: 'audio/mpeg' });
    } catch (e) {
      if (e && e.status === 403) { try { vcode = ''; store.set('vcode', null); setVoice(false); toast('Kode voice tidak valid, voice dimatikan'); } catch {} return null; } // sama seperti chat
      if (tok !== chSayTok) return null;
      if (attempt === 0) await chSleep(700);
    }
  }
  return null;
}
function chVoicePlay(blob) { // nama UNIK: chPlay dipakai fungsi animasi bidak (deklarasi fungsi terakhir menimpa yang pertama — bug voice tidak pernah muncul)
  try {
    chVoiceStop();
    chAudioUrl = URL.createObjectURL(blob);
    const a = chAudio = new Audio(chAudioUrl);
    a.playbackRate = typeof vSpeed === 'number' && vSpeed > 0 ? vSpeed : 1;
    a.onended = () => { if (chAudio === a) chVoiceStop(); };
    return a.play().then(() => true).catch(() => { if (chAudio === a) chVoiceStop(); return false; }); // false = diblokir autoplay browser
  } catch { chVoiceStop(); return Promise.resolve(false); }
}

/* ---------- Catur: animasi + lawan "mikir" ----------
   Papan digambar ulang total (innerHTML) tiap perubahan, jadi gerak bidak dibuat dengan teknik FLIP: setelah papan baru tampil, bidak di kotak tujuan
   "dimundurkan" ke kotak asal lalu digeser kembali ke tempatnya. Respons server memuat langkahmu DAN balasan AI sekaligus, tapi keduanya tidak
   ditampilkan berbarengan: lawan dibuat "mikir" dulu sebentar (chThink — lamanya acak dan ikut tingkat kesulitan, kadang dia mikir lebih lama),
   jadi ada waktu untuk membuat ocehan (csay berjalan paralel) dan permainannya terasa hidup, bukan mesin yang menjawab kilat.
   Urutan di cmove: papan tengah (chMidBoard = posisi setelah langkahmu saja, giliran lawan) → jeda mikir → papan final + bidak AI meluncur.
   Bidak yang tertangkap dipertahankan sebagai "bayangan" sampai bidak penangkapnya tiba. */
const CH_T = { you: 240, ai: 300, fade: 220 };
let chPlan = null, chLock = 0;
const chReduce = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const chSleep = ms => new Promise(r => setTimeout(r, ms));
// jeda "mikir" lawan (ms). lv 1-3 = tingkat permainan, 0 = AI biasa tanpa lawan karakter (lebih gesit). Acak supaya tiap giliran beda kecepatan.
const chThink = lv => {
  const r = Math.random();
  let t = !lv ? 500 + r * 900 : lv === 1 ? 700 + r * 1300 : lv === 2 ? 1000 + r * 1900 : 1400 + r * 2600;
  if (lv && Math.random() < 0.15) t *= 1.6; // kadang dia benar-benar mikir keras
  return Math.round(t);
};
// papan setelah langkah PEMAIN saja (untuk ditampilkan selama lawan mikir): pindah bidak, rokade, en passant, promosi. Hanya untuk tampilan —
// kebenaran langkah tetap divalidasi server, dan papan final selalu yang dikirim server.
function chMidBoard(old, from, to, promo) {
  const b = old.split('');
  const p = promo || b[from];
  b[to] = p; b[from] = '.';
  if (p === 'P' && old[to] === '.' && (to & 7) !== (from & 7)) b[to + 8] = '.' // en passant: pion hitam yang ditangkap ada satu baris di atas kotak tujuan
  if (p === 'K' && Math.abs(to - from) === 2) { // rokade: bentengnya ikut pindah
    if (to > from) { b[from + 1] = b[from + 3]; b[from + 3] = '.' } else { b[from - 1] = b[from - 4]; b[from - 4] = '.' }
  }
  return b.join('');
}
function chUserPlan(old, from, to, promo) { // animasi langkah pemain: old = papan sebelum, cs.game = papan setelah langkah pemain
  const steps = [{ f: from, t: to, delay: 0, dur: CH_T.you }], ghosts = [];
  if (old[to] !== '.') ghosts.push({ sq: to, p: old[to], delay: CH_T.you * 0.45 });             // bidak AI yang kamu tangkap memudar
  if (old[from] === 'K' && Math.abs(to - from) === 2) steps.push(to > from ? { f: from + 3, t: from + 1, delay: 0, dur: CH_T.you } : { f: from - 4, t: from - 1, delay: 0, dur: CH_T.you }); // rokade
  return { steps, ghosts, total: CH_T.you + 40 };
}
function chAiPlan(old, g) { // animasi balasan AI: old = papan tengah (setelah langkah pemain), g = cs.game final dari server
  const steps = [], ghosts = [];
  const { f, t } = g.last, ai = g.board[t];
  const before = old[t];                                                                          // isi kotak tujuan AI sebelum AI melangkah
  steps.push({ f, t, delay: 60, dur: CH_T.ai });
  if (before && before !== '.') ghosts.push({ sq: t, p: before, delay: 60 + CH_T.ai * 0.6 });      // bidakmu yang ditangkap AI bertahan sampai AI tiba
  if (ai === 'k' && Math.abs(t - f) === 2) steps.push(t > f ? { f: f + 3, t: f + 1, delay: 60, dur: CH_T.ai } : { f: f - 4, t: f - 1, delay: 60, dur: CH_T.ai });
  return { steps, ghosts, total: CH_T.ai + 140 };
}
function chPlay(plan) {
  const sq = i => body.querySelector('.ch-sq[data-i="' + i + '"]');
  for (const g of plan.ghosts) {
    const host = sq(g.sq); if (!host) continue;
    const el = document.createElement('span'); el.className = 'ch-p ch-ghost ' + (chIsW(g.p) ? 'ch-w' : 'ch-b'); el.setAttribute('aria-hidden', 'true'); el.textContent = CH_G[g.p.toLowerCase()];
    host.prepend(el);                                                                              // di bawah bidak yang sedang meluncur
    const an = el.animate([{ opacity: 1 }, { opacity: 0 }], { delay: g.delay, duration: CH_T.fade, easing: 'ease-in', fill: 'both' });
    an.onfinish = () => el.remove();
  }
  for (const s of plan.steps) {
    const to = sq(s.t), from = sq(s.f), piece = to && to.querySelector('.ch-p:not(.ch-ghost)'); if (!piece || !from) continue;
    const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
    to.classList.add('ch-fly');                                                                    // naikkan z-index: kotak setelahnya di DOM kalau tidak akan menutupi bidak yang meluncur
    const an = piece.animate([{ transform: 'translate(' + (a.left - b.left) + 'px,' + (a.top - b.top) + 'px) scale(1.08)' }, { transform: 'translate(0,0) scale(1)' }],
      { delay: s.delay, duration: s.dur, easing: 'cubic-bezier(.3,.7,.25,1)', fill: 'backwards' });
    an.onfinish = () => to.classList.remove('ch-fly');
  }
  const bd = body.querySelector('.ch-board'); if (bd) { bd.classList.add('ch-anim'); setTimeout(() => bd.classList.remove('ch-anim'), plan.total); }
  chLock = Date.now() + plan.total;                                                                // jangan terima ketukan di tengah animasi
}
async function cmove(from, to, promo) {
  if (busy || !cs || !cs.game || !cs.game.active) return;
  busy = true; chSel = -1; chPromo = null;
  chSayTok++; chSaying = false; // pemain main cepat: ocehan yang belum sempat muncul dibuang, tidak menumpuk jadi spam
  const pre = cs.game, oldBoard = String(pre.board);
  if (navigator.vibrate) try { navigator.vibrate(10) } catch {}
  let moved = false, painted = false;
  try {
    const okr = await callC('chess/move', { from, to, ...(promo ? { promo } : {}) });
    if (okr) {
      moved = true;
      const fin = cs.game, aiNote = cs.aiNote || '';
      // 1) tahan dulu balasan AI: papan hanya menampilkan langkahmu, lawan "mikir" (jeda acak, ada waktu untuk membuat ocehan)
      const think = chThink(fin.opp ? fin.level : 0);
      const vic = oldBoard[to] !== '.' ? oldBoard[to] : (oldBoard[from] === 'P' && (to & 7) !== (from & 7) ? 'p' : ''); // bidak yang kamu tangkap (pion en passant tidak ada di kotak tujuan)
      const mid = { ...pre, board: chMidBoard(oldBoard, from, to, promo), turn: 'b', moves: null, check: -1, last: { f: from, t: to }, ...(vic ? { capsW: [...pre.capsW, vic] } : {}) };
      cs.game = mid;
      msg = ['', ''];
      if (!chReduce()) chPlan = chUserPlan(oldBoard, from, to, promo);
      painted = true; render();
      const revealAt = Date.now() + think + (chReduce() ? 60 : CH_T.ai + 80); // saat bidak AI mendarat
      chLock = Math.max(chLock, revealAt); // papan terkunci sampai bidak AI mendarat
      csay(revealAt); // ocehan dibuat SEKARANG, paralel dengan jeda mikir; muncul setelah AI melangkah
      await chSleep(think + 30);
      // 2) saatnya: bidak AI meluncur (kalau keadaan sudah diganti fetch lain, keadaan server memang sudah final — tidak perlu apa-apa)
      if (cs.game === mid) {
        cs.game = fin;
        if (fin.result) msg = fin.result.won === 'w' ? ['Menang! ' + (CH_END[fin.result.reason] || '')] : fin.result.won === 'd' ? ['Seri.'] : ['Kalah. ' + (CH_END[fin.result.reason] || '')];
        else msg = ['AI: ' + (aiNote || sq2name(from) + ' ok') + (fin.check >= 0 ? ' · kamu diskak!' : ''), ''];
        if (!chReduce() && aiNote) chPlan = chAiPlan(mid.board, fin);
        render();
      }
    }
  } catch (e) {
    msg = [e.message || 'Gagal mengirim langkah, coba lagi.', 'err'];
    if (e.status === 409) await fetchChess(); // permainan berubah dari perangkat lain
  }
  busy = false;
  if (!painted) render(); // jangan gambar ulang setelah animasi AI jalan: innerHTML baru akan mematikan FLIP-nya
}
async function cresign() {
  if (busy || !cs || !cs.game || !cs.game.active) return;
  busy = true;
  let done = false;
  try { await callC('chess/resign'); done = true; msg = ['Kamu menyerah. Coba lagi dengan tingkat yang lebih ringan?', '']; }
  catch (e) { msg = [e.message || 'Gagal menyerah, coba lagi.', 'err']; }
  busy = false; render();
  if (done) csay();
}
/* ketuk kotak papan: pilih bidak / pilih tujuan / batal pilih */
function csq(i) {
  if (busy || Date.now() < chLock || !cs || !cs.game) return;
  const g = cs.game;
  if (!g.active || g.turn !== 'w' || !g.moves) return;
  i = Number(i);
  if (chSel >= 0 && g.moves[chSel] && g.moves[chSel].includes(i)) {
    // pion putih menuju rank 8 = promosi: tanya dulu jadi apa
    if (g.board[chSel] === 'P' && (i >> 3) === 0) { chPromo = { from: chSel, to: i }; chSel = -1; render(); return; }
    cmove(chSel, i);
    return;
  }
  if (chPromo) return; // sedang memilih bidak promosi
  chSel = (g.moves && g.moves[i] && g.moves[i].length) ? i : -1; // kotak dengan bidak yang bisa jalan
  render();
}

body.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const a = b.dataset.act;
  if (a === 'open') { screen = b.dataset.g; intro = true; msg = ['', '']; chSel = -1; chPromo = null; render(); if (screen === 'pic' && (!ps || picFail)) fetchPic().then(render); if (screen === 'chess' && (!cs || csFail)) fetchChess().then(render); if (screen === 'slot' && window.SLOT) SLOT.enter(); }
  else if (a === 'hub') { screen = 'hub'; intro = true; msg = ['', '']; chSel = -1; chPromo = null; if (window.SLOT) SLOT.leave(); render(); }
  else if (a === 'play') { intro = false; msg = ['', '']; render(); }
  else if (a === 'start') { intro = false; start(); }
  else if (a === 'guess') guess();
  else if (a === 'pstart') { intro = false; pic('pic/start', {}, 'Gagal memuat soal, coba lagi.'); }
  else if (a === 'pskip') pic('pic/start', { skip: true }, 'Gagal melewati soal, coba lagi.');
  else if (a === 'phint') pic('pic/hint', {}, 'Gagal membuka petunjuk, coba lagi.');
  else if (a === 'pguess') pguess();
  else if (a === 'chnew') { intro = true; msg = ['', '']; chSel = -1; chPromo = null; render(); } // kembali ke pilihan tingkat
  else if (a === 'copp') { chOpp = b.dataset.id || ''; try { localStorage.setItem('chessOpp', chOpp); } catch {} render(); }
  else if (a === 'cvoice') { const blob = chPendingAudio; chPendingAudio = null; if (blob) chVoicePlay(blob, false); chSayPaint(); }
  else if (a === 'cstart') cstart(b.dataset.lv);
  else if (a === 'csq') csq(b.dataset.i);
  else if (a === 'cpromo') { if (chPromo) cmove(chPromo.from, chPromo.to, b.dataset.p); }
  else if (a === 'cancelpromo') { chPromo = null; render(); }
  else if (a === 'cresign') {
    if (!chArm) { chArm = setTimeout(() => { chArm = 0; render(); }, 2600); render(); } // teks tombol ikut keadaan chArm di chessScreen()
    else { clearTimeout(chArm); chArm = 0; cresign(); }
  }
  else if (a === 'login') openLogin();
  else if (a === 'retry') load(true);
});
body.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'gmin') { e.preventDefault(); guess(); } else if (e.key === 'Enter' && e.target.id === 'gmpin') { e.preventDefault(); pguess(); } });
body.addEventListener('error', e => { // gambar soal gagal dimuat (error tidak menggelembung, makanya pakai capture)
  if (e.target.classList && e.target.classList.contains('gm-pic')) { e.target.classList.add('hide'); const m = e.target.parentNode.querySelector('.gm-picerr'); if (m) m.classList.remove('hide'); }
}, true);

/* ---------- Kapan menyegarkan ---------- */
window.addEventListener('shell:tab', e => { if (e.detail === 'games') { screen = 'hub'; intro = true; load(); } }); // tiap masuk tab Minigame mulai dari daftar game
window.addEventListener('acct', () => { ready = true; if (active()) load(true); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && active()) load(); });
new MutationObserver(() => { if (active() && $('smodal').classList.contains('hide')) load(true); }) // pulang dari Pengaturan (mungkin baru masuk/keluar akun)
  .observe($('smodal'), { attributes: true, attributeFilter: ['class'] });

paintWallet(loadWallet());
ready = aOn || !!window.__acctSeen; render(); // __acctSeen: paintAcct sudah jalan sebelum file ini dimuat (event 'acct' terlewat)
})();
