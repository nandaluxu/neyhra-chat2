// Persempit: batas jumlah item array vs total karakter?
// Jalankan: node scripts/deepl-limit2.mjs
const UA = 'DeepL/26.41.0 (com.deepl.mobiletranslator; build:264100; Android 14)'
const URL = 'https://oneshot.fal.free.deepl.com/v1/translate'
const post = async texts => {
  try {
    const r = await fetch(URL, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ text: texts, target_lang: 'id' }), signal: AbortSignal.timeout(25000) })
    return r.status
  } catch { return 0 }
}
const line = n => ('kata uji nomor ' + n + ' ').slice(0, 18) /* 18 char per baris */

console.log('== A: jumlah baris (tiap baris 18 char) ==')
for (const n of [10, 30, 50, 80, 100, 120, 150, 200]) {
  const st = await post(Array.from({ length: n }, (_, i) => line(i)))
  console.log('  ' + String(n).padStart(3) + ' baris x 18 char (total ' + (n * 18) + ') -> HTTP ' + st + (st === 400 ? ' << DITOLAK' : ''))
}

console.log('== B: total karakter (jumlah baris tetap 10) ==')
for (const len of [100, 300, 500, 800, 1000, 1500, 2000, 3000]) {
  const st = await post(Array.from({ length: 10 }, () => 'x'.repeat(Math.floor(len / 10))))
  console.log('  10 baris, total ' + String(len).padStart(4) + ' char -> HTTP ' + st + (st === 400 ? ' << DITOLAK' : ''))
}
