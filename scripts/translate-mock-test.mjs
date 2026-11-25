// Uji logika server terjemahan TANPA jaringan: axios.post ditiru (batas total 1500 char -> 400, seperti DeepL asli).
// Jalankan: node scripts/translate-mock-test.mjs
import express from 'express'
import axios from 'axios'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
for (const k of Object.keys(process.env)) if (/^(MUSIC_PTERO|UPSTASH|KV_|REDIS)/i.test(k)) delete process.env[k]
let pass = 0, fail = 0
const ok = (n, c, x = '') => { if (c) { pass++; console.log('  ok -', n) } else { fail++; console.error('  GAGAL -', n, x) } }

let calls = [], limit = 1500, failNext = 0
axios.post = async (url, payload) => {
  const { text } = JSON.parse(payload); calls.push(text)
  if (failNext > 0) { failNext--; const e = new Error('503'); e.response = { status: 503 }; throw e }
  if (text.join('').length > limit) { const e = new Error('400'); e.response = { status: 400 }; throw e }
  return { data: { translations: text.map(t => ({ text: 'ID:' + t })) } }
}
const { musicRouter } = await import(path.join(ROOT, 'lib/music.js'))
const app = express(); app.use(express.json({ limit: '1mb' })); app.use(musicRouter)
const srv = await new Promise(d => { const s = app.listen(0, '127.0.0.1', () => d(s)) })
const post = async b => { const r = await fetch('http://127.0.0.1:' + srv.address().port + '/api/music/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { st: r.status, j: await r.json().catch(() => ({})) } }

{ // 1: lirik panjang, sejajar & refrain berulang hanya dikirim sekali
  calls = []
  const verse = Array.from({ length: 40 }, (_, i) => 'verse line number ' + i + ' with some words')
  const chorus = ['la la la chorus line one', 'la la la chorus line two', '']
  const texts = [...verse, ...chorus, ...verse.slice(0, 5), ...chorus, ...chorus]
  const r = await post({ clientId: 'm1', lang: 'id', text: texts })
  ok('200 & panjang sama', r.st === 200 && r.j.tr.length === texts.length, JSON.stringify(r.j).slice(0, 100))
  ok('terjemahan sejajar (tiap baris = ID:baris, kosong tetap kosong)', texts.every((t, i) => r.j.tr[i] === (t.trim() ? 'ID:' + t.trim() : '')))
  const sent = calls.flat()
  ok('baris berulang dikirim sekali (dedup)', new Set(sent).size === sent.length, sent.length + ' dikirim')
  ok('tidak ada potongan > 1500 char', calls.every(c => c.join('').length <= 1500))
}
{ // 2: kuota menyempit (batas 400 char): potongan dibelah otomatis, tetap sukses
  calls = []; limit = 400
  const texts = Array.from({ length: 30 }, (_, i) => 'a fairly long lyric line number ' + i + ' xx')
  const r = await post({ clientId: 'm2', lang: 'id', text: texts })
  ok('400 batas ketat -> dibelah & sukses', r.st === 200 && r.j.tr.every((t, i) => t === 'ID:' + texts[i]), JSON.stringify(r.j).slice(0, 100))
  limit = 1500
}
{ // 3: gagal sesaat (503 x4 = 2 host x 2 putaran) -> 502, percobaan ulang sukses tanpa mengulang potongan lama
  calls = []; failNext = 4
  const texts = Array.from({ length: 5 }, (_, i) => 'transient fail line ' + i)
  const r1 = await post({ clientId: 'm3', lang: 'id', text: texts })
  ok('gagal terus -> 502', r1.st === 502, String(r1.st))
  const r2 = await post({ clientId: 'm3', lang: 'id', text: texts })
  ok('ulang -> 200', r2.st === 200 && r2.j.tr.length === 5)
}
{ // 4: cache hit tidak memanggil DeepL lagi
  const texts = ['cache line a', 'cache line b']
  await post({ clientId: 'm4', lang: 'id', text: texts }); calls = []
  const r = await post({ clientId: 'm4', lang: 'id', text: texts })
  ok('cache: 200 tanpa panggilan DeepL', r.st === 200 && calls.length === 0)
}
{ // 5: validasi
  const r = await post({ text: ['  ', ''] })
  ok('teks kosong -> 400', r.st === 400)
}
srv.close()
console.log(`Hasil: ${pass} lulus, ${fail} gagal`)
process.exit(fail ? 1 : 0)
