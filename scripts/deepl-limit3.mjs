// Angka pasti: batas jumlah item dan total karakter. Jalankan: node scripts/deepl-limit3.mjs
const UA = 'DeepL/26.41.0 (com.deepl.mobiletranslator; build:264100; Android 14)'
const URL = 'https://oneshot.fal.free.deepl.com/v1/translate'
const post = async texts => {
  try {
    const r = await fetch(URL, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ text: texts, target_lang: 'id' }), signal: AbortSignal.timeout(25000) })
    return r.status
  } catch { return 0 }
}
console.log('== jumlah item (baris 10 char) ==')
for (const n of [95, 98, 99, 100, 101]) {
  console.log('  ' + n + ' baris -> HTTP ' + await post(Array.from({ length: n }, (_, i) => 'baris ' + i)))
}
console.log('== total karakter (5 baris) ==')
for (const total of [1600, 1700, 1750, 1800, 1850, 1900, 2000]) {
  const per = Math.floor(total / 5)
  console.log('  5 baris total ' + total + ' -> HTTP ' + await post(Array.from({ length: 5 }, () => 'a'.repeat(per))))
}
console.log('== 1 baris tunggal panjang ==')
for (const len of [1900, 2000, 5000]) {
  console.log('  1 baris ' + len + ' char -> HTTP ' + await post(['a'.repeat(len)]))
}
