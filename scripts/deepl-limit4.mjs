// Konfirmasi: batas = kuota bergulir (burst) atau statis? Uji dengan jeda antar request.
// Jalankan: node scripts/deepl-limit4.mjs
const UA = 'DeepL/26.41.0 (com.deepl.mobiletranslator; build:264100; Android 14)'
const URL = 'https://oneshot.fal.free.deepl.com/v1/translate'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const post = async texts => {
  try {
    const r = await fetch(URL, { method: POST_M ? 'POST' : 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ text: texts, target_lang: 'id' }), signal: AbortSignal.timeout(25000) })
    const b = await r.text()
    return { st: r.status, why: r.status !== 200 ? b.slice(0, 120) : '' }
  } catch (e) { return { st: 0, why: e.message } }
}
const POST_M = true
console.log('== jeda 60 detik, lalu tangga naik (1x setiap 15 dtk) ==')
await sleep(60000)
for (const total of [1200, 1400, 1600, 1800, 2000, 2500, 3000, 4000]) {
  const r = await post(Array.from({ length: 5 }, () => 'a'.repeat(Math.floor(total / 5))))
  console.log('  total ' + String(total).padStart(4) + ' -> HTTP ' + r.st + (r.why ? '  << ' + r.why : ''))
  await sleep(15000)
}
