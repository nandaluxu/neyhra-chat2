// Tes bahasa voice note + subtitle (id/jp/en/ko/zh) — lib/sessions.js normVoice & lib/finalize.js finalize.
// Jalankan: node scripts/lang-test.mjs  (tanpa env, tanpa jaringan; semua fungsi murni)
import { normVoice, LANGS } from '../lib/sessions.js'
import { finalize, hasKana } from '../lib/finalize.js'

let n = 0, bad = 0
const ok = (cond, label) => { n++; if (cond) console.log(`  ok - ${label}`); else { bad++; console.log(`  FAIL - ${label}`) } }

const ch = { id: 'nagumo', name: 'Nagumo', pronounce: { '南雲': 'ナグモ', 'Nagumo': 'ナグモ' } }
const V = lang => ({ on: true, lang })

console.log('normVoice (lib/sessions.js)')
ok(LANGS.id === 'Indonesia' && LANGS.jp === 'Jepang' && LANGS.en === 'Inggris' && LANGS.ko === 'Korea' && LANGS.zh === 'Mandarin', 'LANGS memuat 5 bahasa')
for (const l of ['id', 'jp', 'en', 'ko', 'zh']) ok(normVoice({ on: true, lang: l }).lang === l, `bahasa sah diterima: ${l}`)
ok(normVoice({ on: true, lang: 'xx' }).lang === 'jp', 'bahasa tak dikenal -> jp (perilaku lama)')
ok(normVoice({ on: true }).lang === 'jp', 'tanpa lang -> jp')
ok(normVoice({ on: false, lang: 'ko' }).on === false, 'voice mati tetap mati')

console.log('hasKana (lib/finalize.js)')
ok(hasKana.test('そうなんだ'), 'kana terdeteksi')
ok(!hasKana.test('好呀我们说汉语'), 'Hanzi Mandarin bukan kana')
ok(!hasKana.test('안녕하세요'), 'Hangul Korea bukan kana')
ok(!hasKana.test('Hello, apa kabar'), 'latin bukan kana')

console.log('finalize — perilaku lama tidak berubah')
{
  const r = finalize({ id: 'Nagumo: halo, aku Nagumo', jp: 'ナグモだよ', vn: 'halo, aku Nagumo' }, ch, V('id'))
  ok(r.id === 'halo, aku Nagumo', 'id: teks chat bersih (label nama dibuang)')
  ok(r.jpText === 'ナグモだよ', 'id: subtitle Jepang utuh')
  ok(/ナグモ/.test(r.vn), 'id: fixReading tetap jalan untuk voice Indonesia (perilaku lama)')
}
{
  const r = finalize({ id: 'ya sudahlah', jp: 'まあいいわ', vn: 'まあ、いいわ' }, ch, V('jp'))
  ok(r.vn === 'まあ、いいわ' && r.jpText === 'まあいいわ', 'jp: voice Jepang dipakai apa adanya')
}
{
  // model lupa <vn> (jepang): fallback ke subtitle — perilaku lama
  const r = finalize({ id: 'ya sudahlah', jp: 'まあいいわ', vn: '' }, ch, V('jp'))
  ok(r.vn === 'まあいいわ', 'jp: <vn> kosong -> pakai teks subtitle')
  // model salah isi (latin padahal harusnya Jepang): fallback ke subtitle
  const r2 = finalize({ id: 'ya sudahlah', jp: 'まあいいわ', vn: 'ya sudahlah' }, ch, V('jp'))
  ok(r2.vn === 'まあいいわ', 'jp: <vn> salah aksara -> pakai teks subtitle')
  // voice Indonesia: <vn> kosong -> teks <id> (bukan subtitle Jepang)
  const r3 = finalize({ id: 'ya sudahlah', jp: 'まあいいわ', vn: '' }, ch, V('id'))
  ok(r3.vn === 'ya sudahlah', 'id: <vn> kosong -> teks <id>')
}

console.log('finalize — bahasa baru (en/ko/zh)')
{
  const r = finalize({ id: 'sudahlah', jp: 'whatever, fine', vn: 'whatever, fine' }, ch, V('en'))
  ok(r.vn === 'whatever, fine' && r.jpText === 'whatever, fine', 'en: subtitle Inggris jadi teks voice')
  const r2 = finalize({ id: 'sudahlah', jp: 'whatever, fine', vn: '' }, ch, V('en'))
  ok(r2.vn === 'whatever, fine', 'en: <vn> kosong -> subtitle Inggris')
}
{
  const ko = '흠, 사실 네가 와 줘서 좋았어'
  const r = finalize({ id: 'hmpf', jp: ko, vn: ko }, ch, V('ko'))
  ok(r.vn === ko && r.jpText === ko, 'ko: voice Korea dipakai utuh')
  // latin padahal harusnya Hangul -> fallback ke subtitle Hangul
  const r2 = finalize({ id: 'hmpf, oke deh', jp: ko, vn: 'hmpf oke deh' }, ch, V('ko'))
  ok(r2.vn === ko, 'ko: <vn> salah aksara -> pakai subtitle Hangul')
  // subtitle juga salah -> teks <id>
  const r3 = finalize({ id: 'hmpf, oke deh', jp: 'hmpf oke deh', vn: 'hmpf oke deh' }, ch, V('ko'))
  ok(r3.vn === 'hmpf, oke deh', 'ko: semua aksara salah -> teks <id>')
  // nama latin TIDAK diganti katakana di teks Korea (fixReading dilewati)
  const r4 = finalize({ id: 'oke', jp: '나구모야', vn: 'Nagumo, 나구모야' }, ch, V('ko'))
  ok(!/ナグモ/.test(r4.vn) && !/ナグモ/.test(r4.jpText), 'ko: fixReading (katakana) tidak merusak teks Korea')
}
{
  const zh = '哼，说吧，我听着呢'
  const r = finalize({ id: 'hmpf', jp: zh, vn: zh }, ch, V('zh'))
  ok(r.vn === zh && r.jpText === zh, 'zh: voice Mandarin dipakai utuh')
  const r2 = finalize({ id: 'hmpf', jp: zh, vn: 'hmpf' }, ch, V('zh'))
  ok(r2.vn === zh, 'zh: <vn> salah aksara -> pakai subtitle Hanzi')
  // kanji di pronounce (南雲 -> ナグモ) tidak boleh menyusup ke teks Mandarin
  const r3 = finalize({ id: '好', jp: '南云你来了', vn: '南云你来了' }, ch, V('zh'))
  ok(!/ナグモ/.test(r3.vn) && !/ナグモ/.test(r3.jpText), 'zh: katakana dari pronounce tidak merusak teks Mandarin')
}

console.log('finalize — roleplay multi ucapan (per bahasa)')
{
  const id = '"Halo, lama tak jumpa."\n\n*menyilangkan tangan*\n\n"Apa kabar?"'
  const r = finalize({ id, jp: '야, 오랜만이야\n\n잘 지냈어?', vn: '야 [laughing] 오랜만이야\n\n잘 지냈어?' }, ch, V('ko'), [ch], true)
  ok(Array.isArray(r.parts) && r.parts.length === 2, 'ko rp: dua ucapan = dua bagian voice note')
  ok(/야/.test(r.parts[0].vn) && /지냈어/.test(r.parts[1].vn), 'ko rp: isi voice note bahasa Korea')
  // ucapan kurang -> dialog dari <id> (fallback)
  const r2 = finalize({ id, jp: '야, 오랜만이야', vn: '야, 오랜만이야' }, ch, V('ko'), [ch], true)
  ok(Array.isArray(r2.parts) && r2.parts.length === 2 && /Halo/.test(r2.parts[0].id), 'ko rp: <vn> kurang -> dialog <id> dipakai')
  // id lama: ucapan bahasa Indonesia, subtitle Jepang
  const r3 = finalize({ id, jp: 'やあ、おひさしぶり\n\n元気だった？', vn: 'Halo, lama tak jumpa\n\nApa kabar?' }, ch, V('id'), [ch], true)
  ok(Array.isArray(r3.parts) && r3.parts.length === 2 && r3.parts[0].jp === 'やあ、おひさしぶり', 'id rp: subtitle tetap Jepang')
}

console.log(`\n${n - bad}/${n} lolos`)
process.exit(bad ? 1 : 0)
