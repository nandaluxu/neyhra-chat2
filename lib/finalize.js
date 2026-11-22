// Perapihan balasan model, dipakai bersama oleh chat biasa (lib/app.js) dan Skenario Skrip (lib/scenario.js).
// Dipindah apa adanya dari app.js supaya tidak ada import melingkar; isinya jangan diubah sembarangan
// karena format <id>/<jp>/<vn> dan tag ekspresi TTS bergantung padanya.

import { fixReading } from './chars.js'

const hasJp = /[\u3040-\u30ff\u4e00-\u9fff]/
// kana saja (tanpa Hanzi): teks Jepang beneran selalu memuat kana, sedangkan Hanzi Mandarin dan Hangul Korea tidak.
// Dipakai /api/tts untuk memutuskan perlakuan pelafalan (lib/chars.js fixReading) hanya layak untuk teks beraksara Jepang.
const hasKana = /[\u3040-\u30ff]/
// cek aksara per bahasa voice (jaga-jaga model salah format: katanya <vn> bahasa Korea tapi isinya huruf latin semua).
// Indonesia dan Inggris sama-sama huruf latin (tidak bisa dibedakan), jadi tidak dicek -> selalu "lolos".
const LANG_RE = { jp: hasJp, ko: /[\uac00-\ud7a3\u3130-\u318f]/, zh: /[\u4e00-\u9fff]/ }
const langOk = (lang, t) => { const re = LANG_RE[lang]; return !re || re.test(String(t || '')) }

// tag ekspresi untuk TTS: [laughing], [sad], (break), ... -> dibuang untuk teks subtitle/chat
const stripTags = t => String(t || '').replace(/\[[^\]]*\]|\((?:break|long[\s_-]?break|breath)\)/gi, ' ').replace(/\s+/g, ' ').trim()
// versi untuk teks chat/subtitle: tag dibuang tapi jeda baris/paragraf dipertahankan (stripTags di atas meratakan semuanya jadi satu baris)
const tidyChat = t => String(t || '').replace(/\[[^\]]*\]|\((?:break|long[\s_-]?break|breath)\)/gi, ' ')
  .replace(/\r\n?/g, '\n').replace(/[ \t\u00a0]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
// kalau model menulis <whisper>kata</whisper>, ubah ke gaya Fish Audio: [whisper] kata [normal voice]
const normTags = t => String(t || '')
  .replace(/<([a-z][a-z \-]{1,24})>([\s\S]*?)<\/\1>/gi, (_, tag, inner) => `[${tag.trim()}] ${inner.trim()} [normal voice]`)
  .replace(/<\/?[a-z][^>]*>/gi, ' ')
  .replace(/\s+/g, ' ').trim()

// Tawa tulis (wkwk, haha, あはは, ...) di teks voice -> diberi tag [laughing]/[chuckling] supaya TTS benar-benar tertawa,
// bukan membaca "w-k-w-k". Tawa yang sudah diberi tag oleh model dibiarkan (hanya teksnya dirapikan).
const LAUGHS = [
  [/\b(?=[wk]{3,}\b)(?=\w*w)(?=\w*k)[wk]+\b|\bawokawok\w*\b/, 'Haha', 'laughing'],  // wkwk, kwkw, awokawok
  [/\b[ae]?(?:ha){2,}h?\b/, null, 'laughing'],                                   // haha, ahaha
  [/\b[ae]?(?:he|hi){2,}h?\b/, null, 'chuckling'],                               // hehe, hihi
  [/\bxi(?:xi)+\b/, 'Hihi', 'chuckling'],
  [/あは{2,}|は{3,}|アハハ+|ハハハ+/, null, 'laughing'],
  [/うふふ+|ふふ+っ?|えへへ+|くすくす|ククク+|クスクス|フフ+|ウフフ+|エヘヘ+/, null, 'chuckling']
].map(([re, sound, kind]) => [new RegExp(`((?:\\[(?:laughing|chuckling)[^\\]]*\\]\\s*)?)(${re.source})([!！?？.。…~]*)`, 'gi'), sound, kind])
const laughify = t => LAUGHS.reduce((out, [re, sound, kind]) =>
  out.replace(re, (_, tag, word, punct) => tag
    ? `${tag}${sound || word}${punct}`
    : `[${kind}] ${sound || word}${punct} [normal voice] `), String(t || ''))
  .replace(/\s*\[normal voice\]\s*$/i, '').replace(/(\[normal voice\])\s+(?=[,，、.。!！?？])/gi, '$1').replace(/\s+/g, ' ').trim()

const baseName = n => String(n || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()

// model kadang meniru format riwayat dan membuka balasan dengan "Nama:" -> dibuang (juga kalau didahului tag ekspresi, mis. "[sad] Furina: ...")
const dropSelfLabel = (text, c) => {
  const esc = k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const names = [...new Set([baseName(c.name), baseName(c.name).split(/[\s/]+/)[0]].filter(Boolean))]
  return String(text || '').replace(new RegExp(`^((?:\\s*\\[[^\\]]*\\])*)\\s*(?:${names.map(esc).join('|')})\\s*[:：]\\s*`, 'i'), '$1 ').trim()
}

// Satu-satunya tempat teks balasan model dirapikan, dipakai chat biasa DAN grup supaya fix tidak perlu ditulis dua kali.
// `readers` = karakter yang namanya mungkin disebut (di grup: semua anggota), supaya bacaan nama (南雲 -> ナグモ) benar walau yang menyebut karakter lain.
// Mode roleplay: narasi *...* tidak boleh ikut diucapkan. Dibuang dari <jp>/<vn>. Tiap ucapan = satu baris = satu voice note (maks MAX_VN).
// Token pemisah lama "long-break" TIDAK dipakai lagi (model sering salah menulisnya); kalau masih muncul (mis. di data lama), diperlakukan sebagai pemisah baris.
const MAX_VN = 3
const LB_RE = /[\[(［（]\s*long[\s_-]*break\s*[\])］）]/gi
const stripLB = t => String(t || '').replace(LB_RE, ' ').replace(/[ \t]+/g, ' ').trim()
const dropNarr = t => String(t || '').replace(/\*[^*]*\*/g, ' ').replace(/\*+/g, ' ').replace(/["“”「」『』]/g, ' ')
const QUOTE_G = /["“]([^"”]+)["”]/g
const hasWord = t => /[\p{L}\p{N}]/u.test(t)
const quotesOf = t => [...String(t || '').matchAll(QUOTE_G)].map(m => m[1].trim()).filter(hasWord)
// <id> dipecah per ucapan: narasi sebelum ucapan ikut ke ucapan itu, narasi penutup ikut ke ucapan terakhir; maksimal MAX_VN kelompok
const idGroups = id => {
  const blocks = String(id || '').split(/\n{2,}/).map(b => b.trim()).filter(Boolean), g = []
  let cur = []
  for (const b of blocks) { cur.push(b); if (quotesOf(b).length) { g.push(cur); cur = [] } }
  if (cur.length) { if (g.length) g[g.length - 1].push(...cur); else g.push(cur) }
  const out = g.map(x => x.join('\n\n'))
  return out.length > MAX_VN ? [...out.slice(0, MAX_VN - 1), out.slice(MAX_VN - 1).join('\n\n')] : out
}
// <jp>/<vn> dipecah per baris (atau per token lama), narasi dibuang
const segsOf = t => String(t || '').split(new RegExp(`\\n+|${LB_RE.source}`, 'i')).map(x => dropNarr(x).replace(/\s+/g, ' ').trim()).filter(hasWord)
const fitTo = (a, n) => a.length > n ? [...a.slice(0, n - 1), a.slice(n - 1).join(' ')] : a

export function finalize(out, c, voice, readers = [c], rp = false) {
  const pronounce = Object.assign({}, ...readers.map(r => r?.pronounce).filter(Boolean))
  const reader = { ...c, pronounce: Object.keys(pronounce).length ? pronounce : undefined }
  // id/jp: subtitle dan voice memakai aksara Jepang -> aturan pronounce (katakana) relevan.
  // en/ko/zh: nilai pronounce (katakana) justru merusak teks bahasa itu, jadi fixReading dilewati.
  const jpCtx = voice.lang === 'id' || voice.lang === 'jp'
  let id = dropSelfLabel(tidyChat(out.id), c)
  if (rp) id = id.replace(/\*{2,}/g, '*')
  if (!id) throw new Error('Respons kosong')
  if (!voice.on) return { id }
  if (!rp) {
    const jpText = jpCtx ? fixReading(reader, dropSelfLabel(tidyChat(out.jp), c)) : dropSelfLabel(tidyChat(out.jp), c) // 南雲 -> ナグモ, dll, supaya subtitle tidak salah baca
    let vn = jpCtx ? fixReading(reader, dropSelfLabel(stripLB(normTags(out.vn)), c)) : dropSelfLabel(stripLB(normTags(out.vn)), c)
    // fallback kalau model salah format: subtitle hanya dipakai kalau bahasanya = bahasa voice itu (jp/en, atau ko/zh dengan aksara cocok).
    // Voice Indonesia tidak pernah pakai fallback subtitle (subtitlenya Jepang, voice-nya Indonesia) -> pakai teks <id>.
    const subOk = voice.lang === 'id' ? false : (voice.lang === 'jp' || voice.lang === 'en') ? !!jpText : langOk(voice.lang, jpText)
    if (!vn || !langOk(voice.lang, vn)) vn = subOk ? (jpText || id) : id
    return { id, jpText, vn: laughify(vn) }
  }
  // roleplay: satu ucapan = satu voice note
  const groups = idGroups(id), want = groups.length
  const dlg = groups.map(g => { const q = quotesOf(g); return q.length ? q.join(' ') : dropNarr(g).replace(/\s+/g, ' ').trim() })
  const fixJp = jpCtx
    ? (x => fixReading(reader, dropSelfLabel(tidyChat(x), c)))
    : (x => dropSelfLabel(tidyChat(x), c))
  const fixVn = x => laughify(jpCtx ? fixReading(reader, dropSelfLabel(normTags(x), c)) : dropSelfLabel(normTags(x), c))
  const js = fitTo(segsOf(out.jp), want).map(fixJp)
  let vs = fitTo(segsOf(out.vn).map(x => stripLB(x)), want)
  const bad = vs.length < want || !langOk(voice.lang, vs.join(''))
  const jsOk = voice.lang !== 'id' && js.length >= want && (voice.lang === 'en' || langOk(voice.lang, js.join('')))
  if (bad) vs = jsOk ? js.map(x => dropNarr(x).replace(/\s+/g, ' ').trim()) : dlg // jaga-jaga model salah format / ucapan kurang
  vs = vs.map(fixVn)
  const jps = js.length === want ? js : groups.map(() => '')
  const res = { id, jpText: js.join('\n\n'), vn: vs.join(' ') }
  if (want > 1) res.parts = groups.map((g, i) => ({ id: g, jp: jps[i], vn: vs[i] }))
  return res
}

export { hasJp, hasKana, stripTags, baseName, stripLB }
