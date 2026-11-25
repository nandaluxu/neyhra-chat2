// Cari batas panjang total teks per request di endpoint DeepL oneshot (binary search kasar).
// Jalankan: node scripts/deepl-limit.mjs
const UA = 'DeepL/26.41.0 (com.deepl.mobiletranslator; build:264100; Android 14)'
const URL = 'https://oneshot.fal.free.deepl.com/v1/translate'
const post = async texts => {
  try {
    const r = await fetch(URL, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ text: texts, target_lang: 'id' }), signal: AbortSignal.timeout(25000) })
    return { status: r.status, total: texts.join('\n').length, n: texts.length }
  } catch (e) { return { status: 0, err: e.message } }
}
// baris pendek ~40 char, jumlah baris disesuaikan
const mk = (totalChars, lineLen = 40) => { const n = Math.max(1, Math.ceil(totalChars / lineLen)); return Array.from({ length: n }, (_, i) => ('kata uji nomor ' + i + ' ').slice(0, lineLen)) }
for (const t of [5000, 10000, 20000, 25000, 30000, 40000, 60000, 80000, 120000]) {
  const r = await post(mk(t))
  console.log('total ~' + String(t).padStart(6) + ' char, ' + String(r.n).padStart(3) + ' baris -> HTTP ' + r.status + (r.status === 400 ? '  << DITOLAK' : ''))
}
