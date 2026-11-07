// Perapihan balasan model, dipakai bersama oleh chat biasa (lib/app.js) dan Skenario Skrip (lib/scenario.js).
// Dipindah apa adanya dari app.js supaya tidak ada import melingkar; isinya jangan diubah sembarangan
// karena format <id>/<jp>/<vn> dan tag ekspresi TTS bergantung padanya.

import { fixReading } from './chars.js'

const hasJp = /[\u3040-\u30ff\u4e00-\u9fff]/

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
// Mode roleplay: narasi *...* tidak boleh ikut diucapkan. Dibuang dari <jp>/<vn>, dan [long-break] jadi pemisah antar ucapan.
const LB = '[long-break]'
// model sering salah tulis: (long-break) (long break) [long break] [long_break] [Long-Break] atau kurung full-width -> semua dinormalkan ke [long-break]
const LB_RE = /[\[(［（]\s*long[\s_-]*break\s*[\])］）]/gi
const LB_ESC = LB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const normLB = t => String(t || '').replace(LB_RE, LB)
const dropNarr = t => String(t || '').replace(/\*[^*]*\*/g, ' ').replace(/\*+/g, ' ').replace(/["“”「」『』]/g, ' ')
const tidyLB = t => String(t || '').replace(LB_RE, ` ${LB} `).replace(/\s+/g, ' ')
  .replace(new RegExp(`(?:${LB_ESC}\\s*){2,}`, 'g'), `${LB} `).replace(new RegExp(`^(?:\\s*${LB_ESC})+\\s*`), '').replace(new RegExp(`(?:\\s*${LB_ESC})+\\s*$`), '').trim()
const dialogueOf = id => { const d = [...String(id || '').matchAll(/["\u201c]([^"\u201d]+)["\u201d]/g)].map(m => m[1].trim()).filter(Boolean); return d.length ? d.join(` ${LB} `) : dropNarr(id).replace(/\s+/g, ' ').trim() }

export function finalize(out, c, voice, readers = [c], rp = false) {
  const pronounce = Object.assign({}, ...readers.map(r => r?.pronounce).filter(Boolean))
  const reader = { ...c, pronounce: Object.keys(pronounce).length ? pronounce : undefined }
  let id = dropSelfLabel(tidyChat(out.id), c)
  if (rp) id = id.replace(/\*{2,}/g, '*')
  if (!id) throw new Error('Respons kosong')
  if (!voice.on) return { id }
  const jpText = fixReading(reader, dropSelfLabel(tidyChat(rp ? dropNarr(String(out.jp || '').replace(LB_RE, '\n\n')) : out.jp), c)) // 南雲 -> ナグモ, dll, supaya subtitle tidak salah baca
  let vn = fixReading(reader, dropSelfLabel(rp ? tidyLB(dropNarr(normTags(out.vn))) : normLB(normTags(out.vn)), c))
  if (!vn || (voice.lang === 'jp' && !hasJp.test(vn))) vn = rp ? (voice.lang === 'jp' && jpText ? jpText.replace(/\s*\n+\s*/g, ` ${LB} `) : dialogueOf(id)) : voice.lang === 'jp' ? (jpText || id) : id // jaga-jaga model salah format
  if (rp) { // jaring pengaman: ucapan di <vn> tidak boleh lebih sedikit dari ucapan di <id> (kalau model tetap tidak lengkap setelah diminta ulang)
    const n = [...id.matchAll(/["\u201c]([^"\u201d]+)["\u201d]/g)].filter(m => m[1].trim()).length
    const segs = t => String(t).split(LB).filter(x => /[\p{L}\p{N}]/u.test(x)).length
    if (n > 1 && segs(vn) < n) {
      const jpSegs = jpText.split(/\n+/).filter(x => x.trim())
      if (voice.lang === 'jp') { if (jpSegs.length >= n) vn = jpSegs.map(x => dropNarr(x).replace(/\s+/g, ' ').trim()).join(` ${LB} `) } else vn = dialogueOf(id)
    }
  }
  return { id, jpText, vn: laughify(vn) }
}

export { hasJp, stripTags, baseName, normLB }
