// Uji perilaku endpoint DeepL gratis (oneshot) terhadap pola input nyata dari fitur terjemahan lirik:
// batch besar, baris kosong, karakter Jepang, dan rentetan permintaan (rate limit).
// Jalankan: node scripts/deepl-probe.mjs
import crypto from 'node:crypto'

const UA = 'DeepL/26.41.0 (com.deepl.mobiletranslator; build:264100; Android 14)'
const URLS = ['https://oneshot.fal.free.deepl.com/v1/translate', 'https://oneshot.kef.free.deepl.com/v1/translate']

const post = async (url, texts, target = 'id') => {
  const t0 = Date.now()
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ text: texts, target_lang: target }), signal: AbortSignal.timeout(25000) })
    const body = await r.text()
    let j = null; try { j = JSON.parse(body) } catch {}
    return { status: r.status, ms: Date.now() - t0, n: Array.isArray(j && j.translations) ? j.translations.length : null, body: body.slice(0, 200) }
  } catch (e) { return { status: 0, ms: Date.now() - t0, err: e.message } }
}

console.log('== [1] batch besar: 200 baris x ~600 karakter (maks yang dikirim server) ==')
{
  const texts = Array.from({ length: 200 }, (_, i) => ('Baris lirik nomor ' + i + ' ').repeat(24).slice(0, 600))
  const r = await post(URLS[0], texts)
  console.log(JSON.stringify(r))
  console.log('   -> baris terjemahan:', r.n, '| status:', r.status, r.status === 200 ? '(diterima)' : '(DITOLAK)')
}

console.log('== [2] baris kosong bercampur (lirik nyata punya baris kosong/instrumental) ==')
{
  const texts = ['Hello world', '', 'How are you', '   ', 'Goodbye']
  const r = await post(URLS[0], texts)
  console.log(JSON.stringify(r))
  if (r.n) console.log('   -> jumlah hasil:', r.n, '| baris kosong dijawab:', JSON.stringify(r.body).includes('""') ? 'ya' : '?')
}

console.log('== [3] lirik Jepang (kasus umum: lagu anime) ==')
{
  const texts = ['夜に駆ける星を追って', '君のことが好きだ', 'さようなら']
  const r = await post(URLS[0], texts)
  console.log(JSON.stringify(r))
}

console.log('== [4] satu baris sangat panjang (lirik plain tanpa \\n yang dipecah) ==')
{
  const texts = [('Long lyric line without breaks ').repeat(30)].slice(0, 1) /* ~870 char, > batas 600 server */
  const r = await post(URLS[0], [texts[0].slice(0, 600)])
  console.log(JSON.stringify(r))
}

console.log('== [5] rentetan 24 permintaan cepat dari IP yang sama (rate-limit server app: 20/menit) ==')
{
  for (let i = 1; i <= 24; i++) {
    const r = await post(URLS[i % 2], ['Quick test number ' + i])
    process.stdout.write('  #' + String(i).padStart(2) + ': HTTP ' + r.status + ' (' + r.ms + 'ms)' + (r.status !== 200 ? ' << ' + (r.body || r.err || '').slice(0, 80) : '') + '\n')
  }
}

console.log('== [6] host kedua (kef) sanity ==')
{
  const r = await post(URLS[1], ['Sanity check'])
  console.log(JSON.stringify(r))
}
console.log('selesai')
