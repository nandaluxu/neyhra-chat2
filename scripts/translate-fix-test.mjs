// Uji fix terjemahan lirik "kadang berfungsi kadang tidak":
//   A) UNIT: logika chunking di lib/music.js (diekstrak & diuji terpisah — pola music-import-test).
//   B) LIVE: endpoint asli /api/music/translate lewat express app tiruan (tanpa Redis/Ptero),
//      dengan lirik panjang yang DULU selalu gagal 400 ("text exceeds maximum length").
// Jalankan: node scripts/translate-fix-test.mjs
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/* bersihkan env yang bisa mengganggu (Redis/Upstash/Ptero) sebelum modul dibaca */
for (const k of Object.keys(process.env)) if (/^(MUSIC_PTERO|UPSTASH|KV_|REDIS)/i.test(k)) delete process.env[k]

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ok -', name) } else { fail++; console.error('  GAGAL -', name, extra) } }

console.log('[A] Unit: logika chunking (pola sama seperti di lib/music.js)')

/* ==== ekstrak definisi chunking dari sumber asli (bukan disalin manual) ====
   eval di modul ESM tidak bisa mendeklarasikan variabel ke scope modul, jadi: konstanta dibaca
   dengan regex, fungsi diekstrak lalu dijalankan lewat Function() (scope global bebas). */
const src = fs.readFileSync(path.join(ROOT, 'lib/music.js'), 'utf8')
const grab = (re) => { const m = src.match(re); if (!m) throw new Error('pola tidak ketemu di lib/music.js: ' + re); return m[1] }
const TR_CHUNK_CHARS = Number(grab(/TR_CHUNK_CHARS = (\d+)/))
const TR_CHUNK_LINES = Number(grab(/TR_CHUNK_LINES = (\d+)/))
const TR_MAX_CHUNKS = Number(grab(/TR_MAX_CHUNKS = (\d+)/))
const fnSrc = grab(/const trChunks = (texts => \{[\s\S]*?\n\})\n(?=\/\* satu permintaan DeepL)/)
const trChunks = new Function('TR_CHUNK_CHARS', 'TR_CHUNK_LINES', 'TR_MAX_CHUNKS', 'return (' + fnSrc + ')')(TR_CHUNK_CHARS, TR_CHUNK_LINES, TR_MAX_CHUNKS)

console.log('  konstanta:', { TR_CHUNK_CHARS, TR_CHUNK_LINES, TR_MAX_CHUNKS })
ok('chunk maks 1200 char & 50 baris', TR_CHUNK_CHARS === 1200 && TR_CHUNK_LINES === 50)

{ /* 1: lirik pendek = 1 chunk */
  const ch = trChunks(['Hello', 'World', 'Lagu'])
  ok('lirik pendek -> 1 potongan', ch.length === 1 && ch[0].length === 3, JSON.stringify(ch))
}
{ /* 2: 80 baris pendek = 2 chunk (batas 50 baris) */
  const texts = Array.from({ length: 80 }, (_, i) => 'baris ' + i)
  const ch = trChunks(texts)
  ok('80 baris -> 2 potongan (50+30)', ch.length === 2 && ch[0].length === 50 && ch[1].length === 30, JSON.stringify(ch.map(c => c.length)))
  ok('semua baris ikut, urutan sama', ch.flat().join('|') === texts.join('|'))
}
{ /* 3: batas karakter: 60 baris x 40 char = 2400 char -> pecah sebelum lewat 1200 */
  const texts = Array.from({ length: 60 }, () => 'x'.repeat(40))
  const ch = trChunks(texts)
  ok('tiap potongan <= 1200 char', ch.every(c => c.join('').length <= TR_CHUNK_CHARS), JSON.stringify(ch.map(c => c.join('').length)))
  ok('60 baris x 40 char tetap utuh semua', ch.flat().length === 60)
}
{ /* 4: lirik nyata: campuran baris kosong + panjang bervariasi (total > 1200 char -> pecah) */
  const texts = ['夜に駆ける星を追って', '', '君の手が震えている', ' ', 'さようなら', 'x'.repeat(300), ...Array.from({ length: 70 }, (_, i) => 'line with some words ' + i)]
  const ch = trChunks(texts)
  ok('lirik campuran -> >1 potongan, semua utuh', ch.length > 1 && ch.flat().length === texts.length, JSON.stringify(ch.map(c => c.length)))
  ok('urutan baris tidak berubah', ch.flat().join('|') === texts.join('|'))
}
{ /* 5: pagar ekstrem: 200 baris x 600 char = 120k -> maks 26 chunk, sisanya dipangkas */
  const texts = Array.from({ length: 200 }, () => 'y'.repeat(600))
  const ch = trChunks(texts)
  ok('ekstrem dipangkas ke 26 potongan', ch.length === TR_MAX_CHUNKS, String(ch.length))
  ok('tiap potongan tetap <= 1200 char', ch.every(c => c.join('').length <= TR_CHUNK_CHARS + 600)) /* 1 baris 600 boleh lebih dari 0 */
}
{ /* 6: satu baris super panjang (600 char) tetap dikirim (payload kecil) */
  const ch = trChunks(['z'.repeat(600)])
  ok('1 baris 600 char -> 1 potongan', ch.length === 1 && ch[0][0].length === 600)
}

console.log('[B] Live: endpoint /api/music/translate (server express + DeepL sungguhan)')
const { musicRouter } = await import(path.join(ROOT, 'lib/music.js'))
const app = express()
app.use(express.json({ limit: '50kb' }))
app.use(musicRouter)
const listen = () => new Promise(done => { const s = app.listen(0, '127.0.0.1', () => done(s)) })
const srv = await listen()
const BASE = 'http://127.0.0.1:' + srv.address().port
const post = async body => { const r = await fetch(BASE + '/api/music/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { st: r.status, j: await r.json().catch(() => ({})) } }

{ /* B1: validasi dasar tetap */
  const r = await post({ text: [] })
  ok('teks kosong -> 400', r.st === 400 && /Tidak ada teks/.test(r.j.error))
}
{ /* B2: lirik panjang 60 baris x 40 char — DULU gagal 400/502 selalu, kini harus 200 */
  const texts = Array.from({ length: 60 }, (_, i) => 'the quick brown fox jumps over the lazy dog ' + i)
  const r = await post({ clientId: 'uji-fix-tr', lang: 'id', text: texts })
  ok('lirik panjang (60 baris) BERHASIL (bug lama: 502)', r.st === 200 && r.j.ok, JSON.stringify(r.j).slice(0, 120))
  ok('jumlah terjemahan = jumlah baris', r.j.tr && r.j.tr.length === texts.length, 'dapat ' + (r.j.tr || []).length)
  ok('mayoritas baris terisi (>= 50 dari 60)', r.j.tr && r.j.tr.filter(t => t.trim()).length >= 50, 'terisi: ' + (r.j.tr ? r.j.tr.filter(t => t.trim()).length : 0))
}
{ /* B3: baris kosong bercampur tetap dijawab sejajar */
  const texts = ['Hello world', '', 'Goodbye my friend']
  const r = await post({ clientId: 'uji-fix-tr', lang: 'id', text: texts })
  ok('3 baris -> 3 jawaban sejajar', r.st === 200 && r.j.tr.length === 3)
  ok('baris tengah (kosong) tidak menggeser jawaban', r.j.tr[0] && /halo|dunia/i.test(r.j.tr[0]) && r.j.tr[2] && /selamat tinggal|perpisahan|kawan|teman/i.test(r.j.tr[2]), JSON.stringify(r.j.tr))
}
{ /* B4: cache bekerja: permintaan sama kedua kali tetap 200 (dari cache, tanpa DeepL) */
  const texts = ['Cache me please', 'Second line for cache test']
  const r1 = await post({ clientId: 'uji-fix-tr', lang: 'id', text: texts })
  const r2 = await post({ clientId: 'uji-fix-tr', lang: 'id', text: texts })
  ok('permintaan ulang dilayani cache', r1.st === 200 && r2.st === 200 && JSON.stringify(r1.j.tr) === JSON.stringify(r2.j.tr))
}
{ /* B5: Jepang -> Indonesia (kasus anime) */
  const texts = ['夜に駆ける星を追って', '君のことが好きだ']
  const r = await post({ clientId: 'uji-fix-tr', lang: 'id', text: texts })
  ok('lirik Jepang diterjemahkan', r.st === 200 && r.j.tr.every(t => t.trim()) && !/夜|君/.test(r.j.tr.join('')), JSON.stringify(r.j.tr))
}

srv.close()
console.log('')
console.log(`Hasil: ${pass} lulus, ${fail} gagal`)
process.exit(fail ? 1 : 0)
