/* Uji logika Memori-Tulis + Pesan-Disematkan (pin) yang baru ditambahkan ke public/index.html.
   Kode diambil LANGSUNG dari file (bukan salinan), lalu dijalankan dengan mock localStorage. */
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf-8');

/* ---- ekstraksi: potongan fungsi dari file sumber ---- */
const grab = (start, end, include = true) => {
  const i = html.indexOf(start);
  if (i < 0) throw new Error('marka tidak ketemu: ' + start.slice(0, 50));
  const j = html.indexOf(end, i);
  if (j < 0) throw new Error('penutup tidak ketemu');
  return html.slice(i, j + (include ? end.length : 0));
};

const srcWriteMem = grab('function writeMemEntry(id,title,body){', '\n}');
const srcCleanMem = grab('const cleanMemEntry=', '\n};');
const srcCleanPin = grab('const cleanPinEntry=', '\n};');
const srcLoadPin = grab('const loadPin=', '\nconst savePin=', false);
const srcSavePin = grab('const savePin=', '\nconst isPinned=', false);
const srcIsPinned = grab('const isPinned=', '\nfunction pinAdd(', false);
const srcPinAdd = grab('function pinAdd(id,e){', '\n}');
const srcPinRemove = grab('const pinRemove=', '\nfunction markPinRows(', false);
const srcMergePin = grab('if(Array.isArray(c.pin)&&c.pin.length){', '\n      }');

/* ---- mock perangkat ---- */
const mem = new Map(); // pengganti localStorage
const store = {
  get: k => (mem.has(k) ? mem.get(k) : null),
  set(k, v) { v == null ? mem.delete(k) : mem.set(k, v); },
};
const isNum = x => typeof x === 'number' && isFinite(x);
const isKey = x => typeof x === 'string' && /^[\w-]{1,48}$/.test(x);
const loadMem = id => { try { const m = JSON.parse(store.get('mem:' + id) || '[]'); return Array.isArray(m) ? m : [] } catch { return [] } };
const saveMem = (id, m) => { const v = m.length ? JSON.stringify(m) : null; store.set('mem:' + id, v); return store.get('mem:' + id) === v };
let shellTouched = 0; const Shell = { touch() { shellTouched++ } };

/* ---- muat kode asli ---- */
const env = {};
const mk = new Function('store', 'isNum', 'isKey', 'loadMem', 'saveMem', 'Shell', 'PIN_MAX', 'window',
  srcWriteMem + '\n' + srcCleanMem + '\n' + srcCleanPin + '\n' + srcLoadPin + '\n' + srcSavePin + '\n' + srcIsPinned + '\n' + srcPinAdd + '\n' + srcPinRemove + '\n' +
  `return {writeMemEntry,cleanMemEntry,cleanPinEntry,loadPin,savePin,isPinned,pinAdd,pinRemove};`);
Object.assign(env, mk(store, isNum, isKey, loadMem, saveMem, Shell, 100, { Shell }));

let fails = 0, oks = 0;
const ok = (name, cond) => { cond ? oks++ : (fails++, console.error('GAGAL:', name)); };

/* ---- 1) Tulis memori: entri valid + tanda "ditulis tangan" ---- */
{
  const r = env.writeMemEntry('kuro', '  Keluarga besar  ', 'Ayahnya kepala guild, dua kakak.\n\nJanji ketemu minggu depan. ');
  ok('writeMem ok', r.ok === true);
  const m = JSON.parse(store.get('mem:kuro'));
  ok('writeMem judul dipangkas', m[0].title === 'Keluarga besar');
  ok('writeMem mn=1', m[0].mn === 1);
  ok('writeMem ts', isNum(m[0].ts) && m[0].ts > 0);
  ok('writeMem id unik', isKey(m[0].id));
  const r2 = env.writeMemEntry('kuro', '', 'isi tanpa judul');
  ok('writeMem tanpa judul ditolak', r2.err && !r2.ok);
  const r3 = env.writeMemEntry('kuro', 'j', '   ');
  ok('writeMem isi kosong ditolak', r3.err && !r3.ok);
}
/* ---- 2) cleanMemEntry: mn bertahan, sampah ditolak ---- */
{
  const e = env.cleanMemEntry({ id: 'm1', title: 'T', body: 'B', ts: 123, n: 5, mn: true });
  ok('cleanMem mn dipertahankan', e.mn === true);
  ok('cleanMem n clamp', e.n === 5);
  const e2 = env.cleanMemEntry({ id: 'm2', title: 'T', body: 'B' });
  ok('cleanMem tanpa mn tidak ada field', !('mn' in e2));
  ok('cleanMem sampah ditolak', env.cleanMemEntry(null) === null && env.cleanMemEntry({ id: 'x', title: '', body: 'B' }) === null);
}
/* ---- 3) Pin: simpan, duplikat, batas ---- */
{
  const now = Date.now();
  const log1 = { t: now, r: 'them', x: 'Silsilah keluarga: ayah Aldric, ibu Mira, kakak Sena.' };
  const r = env.pinAdd('kuro', log1);
  ok('pinAdd ok', r.ok === true);
  ok('isPinned', env.isPinned('kuro', now) === true);
  ok('isPinned pesan lain false', env.isPinned('kuro', now + 1) === false);
  const r2 = env.pinAdd('kuro', log1);
  ok('pinAdd duplikat tidak dobel', r2.already === true && env.loadPin('kuro').length === 1);
  const r3 = env.pinAdd('kuro', { t: now + 2, r: 'me', x: '   ' });
  ok('pinAdd teks kosong ditolak', !!r3.err);
  const r4 = env.pinAdd('kuro', { t: now + 3, r: 'vn', x: 'ucapan', jp: '字幕', lang: 'jp' });
  ok('pinAdd vn ok', r4.ok === true);
  const pins = env.loadPin('kuro');
  ok('pin vn menyimpan jp+lang', pins[1].jp === '字幕' && pins[1].lang === 'jp');
  env.pinRemove('kuro', now);
  ok('pinRemove', env.loadPin('kuro').length === 1 && !env.isPinned('kuro', now));
  env.savePin('kuro', []);
  ok('savePin kosong jadi null', store.get('pin:kuro') === null);
  /* batas PIN_MAX (ambil nilai asli dari file) */
  const pmax = Number(html.match(/const PIN_MAX=(\d+)/)[1]);
  ok('PIN_MAX terbaca', pmax === 100);
  for (let i = 0; i < pmax; i++) env.pinAdd('reze', { t: 1000 + i, r: 'them', x: 'p' + i });
  const full = env.pinAdd('reze', { t: 99999, r: 'them', x: 'x' });
  ok('pinAdd mentok batas', !!full.err && env.loadPin('reze').length === pmax);
}
/* ---- 4) cleanPinEntry ---- */
{
  const e = env.cleanPinEntry({ t: 5, r: 'them', x: 'penting', ts: 9 });
  ok('cleanPin valid', e && e.x === 'penting' && e.ts === 9);
  ok('cleanPin role asing ditolak', env.cleanPinEntry({ t: 5, r: 'admin', x: 'x' }) === null);
  ok('cleanPin teks kosong ditolak', env.cleanPinEntry({ t: 5, r: 'them', x: '  ' }) === null);
  ok('cleanPin tanpa ts jadi 0', env.cleanPinEntry({ t: 5, r: 'them', x: 'x' }).ts === 0);
}
/* ---- 5) gabungan pin saat impor/sinkron (kode asli applyImport) ---- */
{
  env.savePin('kuro', [{ t: 100, r: 'them', x: 'lama', ts: 10 }]);
  const pinUp0 = 0;
  let pinUp = pinUp0;
  const c = { id: 'kuro', pin: [
    { t: 100, r: 'them', x: 'baru (perangkat lain menyematkan ulang)', ts: 99 },
    { t: 200, r: 'me', x: 'pesanmu sendiri', ts: 50 },
    { t: 300, r: 'them', x: ' ', ts: 60 },            // kosong -> dibuang
    { t: 400, r: 'them', x: 'x', r2: '?' },            // tetap masuk (r valid)
  ] };
  const fn = new Function('c', 'loadPin', 'savePin', 'cleanPinEntry', 'PIN_MAX', 'pinUp',
    srcMergePin + '\nreturn pinUp;');
  pinUp = fn(c, env.loadPin, env.savePin, env.cleanPinEntry, 100, pinUp);
  const merged = env.loadPin('kuro');
  ok('merge pin jumlah', merged.length === 3);
  ok('merge pin terbaru menang', merged.find(x => x.t === 100).x.startsWith('baru'));
  ok('merge pin pinUp terhitung', pinUp === 3);
  ok('merge pin urut ts', merged[0].ts <= merged[1].ts && merged[1].ts <= merged[2].ts);
}
/* ---- 6) scan kunci collectChars mengenali pin: ---- */
{
  const line = html.match(/for\(let i=0;i<localStorage\.length;i\+\+\)\{ const k=localStorage\.key\(i\); if\(k\.startsWith\('log:'\).*?\}\}/s);
  ok('scan collectChars ada', !!line);
  ok('scan menyertakan pin:', line[0].includes("startsWith('pin:')"));
  const hl = html.match(/hasLocalData=\(\)=>\{ try\{ for[\s\S]*?\} /);
  ok('hasLocalData menyertakan pin', hl && hl[0].includes('|pin|'));
}
/* ---- 7) renderCharMem tidak lagi gerbang devOn untuk Ringkas sekarang ---- */
{
  const i = html.indexOf("Ringkas sekarang (semua user");
  ok('tombol Ringkas sekarang tanpa gerbang dev', i > 0 && html.slice(i - 200, i).indexOf('devOn()') < 0);
  ok('tombol Tulis memori di dmdev', html.includes("w.textContent='Tulis memori'; w.onclick=()=>openMw(id);"));
}

console.log(`\n${oks} lulus, ${fails} gagal`);
process.exit(fails ? 1 : 0);
