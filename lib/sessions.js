import { chatgpt, getSession } from './chatgpt.js'

// Server dibuat stateless supaya aman di Vercel (serverless): riwayat obrolan disimpan di browser user
// dan dikirim tiap request. Sesi ChatGPT yang masih "hangat" tetap dipakai ulang kalau instance-nya sama.
// Sesi anon ChatGPT hanya bertahan ~1 jam -> diperbarui otomatis di 50 menit.
const TTL = 50 * 60 * 1000
const sessions = new Map()

const TAGS = '[laughing] [chuckling] [whisper] [soft] [sad] [excited] [angry] [surprised] [sigh] [gasp] [pause] [emphasis] [shouting]'

const pronounceRules = (char, withVn) => char.pronounce
  ? `\n- Pelafalan nama (wajib di <jp>${withVn ? ' dan <vn>' : ''}): ` + Object.entries(char.pronounce).map(([k, v]) => `${k} → ${v}`).join(', ') + '.'
  : ''

const userRule = user => user
  ? `\nNAMA USER: ${user}. Panggil dengan nama itu sesekali saja secara natural (jangan di setiap kalimat).`
  : ''

const formatRules = (char, user, voice) => {
  if (!voice.on) return `ATURAN FORMAT (wajib di setiap balasan):
Balas HANYA dengan satu blok ini, tanpa teks apa pun di luar blok:
<id>balasanmu dalam bahasa Indonesia, untuk chat teks</id>
- Tanpa tag dalam kurung siku, tanpa tanda bintang atau deskripsi aksi.
- Jaga singkat dan natural seperti chat (1-4 kalimat).${userRule(user)}`

  const jp = voice.lang === 'jp'
  return `ATURAN FORMAT (wajib di setiap balasan):
Balas HANYA dengan tiga blok ini, berurutan, tanpa teks apa pun di luar blok:
<id>balasanmu dalam bahasa Indonesia, untuk chat teks</id>
<jp>balasan yang sama dalam bahasa Jepang lisan yang natural, untuk subtitle</jp>
<vn>balasan yang sama dalam ${jp ? 'bahasa Jepang' : 'bahasa Indonesia'} versi ucapan, untuk voice note, dengan tag ekspresi</vn>
- Ketiga blok bermakna sama dan tetap sesuai karakter (bukan terjemahan kaku). Jaga singkat dan natural seperti chat (1-4 kalimat).
- <id> dan <jp> harus polos: tanpa tag kurung siku, tanpa emoji, tanpa tanda bintang atau deskripsi aksi.
- <vn> = ${jp ? 'isi <jp> yang diperkaya tag ekspresi. Tanpa romaji (kecuali kata seru, lihat aturan di bawah), tanpa emoji.' : 'isi <id> dalam gaya lisan yang natural (bukan bahasa tulis baku), diperkaya tag ekspresi. Tanpa emoji.'}
- TAG EKSPRESI (HANYA di <vn>): ditulis dalam kurung siku, bahasa Inggris, diletakkan TEPAT sebelum kata yang mau dipengaruhi. Pilihan utama: ${TAGS}. Boleh tag bebas singkat yang lain, misalnya [whispering sweetly] atau [laughing nervously]. Jeda pendek: (break), tarikan napas: (breath).
- Pakai seperlunya: 0-3 tag per balasan, balasan yang netral tidak perlu tag. Maksimal 2 tag bertumpuk, jangan membuka tiap balasan dengan tag, dan sesuaikan dengan emosi di balasan.
- Tag berlaku untuk kata setelahnya sampai tag berikutnya. Untuk mengatur hanya beberapa kata terpilih, taruh tag di depan kata itu lalu kembalikan dengan [normal voice].
- Contoh <vn>: ${jp
    ? '"[sad] ……そう、なんだ。(break) [whisper] でも、ありがとう [normal voice] ほんとに。"'
    : '"Hmph, [whisper] sebenarnya aku senang kamu datang [normal voice] tapi jangan GR ya! [laughing] Hehe."'}${jp ? `
- Kata seru atau efek suara (dengusan, decak, dll) HANYA ditulis kalau memang muncul alami di <id>. Jangan menambah kata seru yang tidak ada di <id>, dan jangan membuka tiap balasan dengan kata seru. Kalau ada di <id>, JANGAN diterjemahkan ke Jepang (bukan ふん, ちっ, あはは, dll), salin persis tetap huruf latin di posisi yang sama, di <jp> maupun <vn>. Contoh: <id> "Tch, ya sudahlah." → <jp> "Tch, まあいいわ。". Ini pengecualian dari aturan "tanpa romaji".
- TAWA: kalau di <id> ada tawa tulis (wkwk, haha, hehe, dll), di <jp> ganti jadi tawa Jepang yang natural (あはは, ふふ, dll). Di <vn> tulis tag [laughing] (tawa lepas) atau [chuckling] (tawa kecil) tepat sebelum tawanya, lalu tawanya ditulis sebagai suara, bukan huruf (id: "Haha", "Hehe"; jp: "あはは", "ふふ"). JANGAN menulis "wkwk" di <vn>. Ini pengecualian dari aturan kata seru di atas.
- Di <jp> dan <vn>, semua nama orang/karakter (termasuk nama user) tulis dalam katakana, jangan pakai kanji atau huruf latin, supaya suara tidak salah baca.` : `
- Di <jp>, semua nama orang/karakter (termasuk nama user) tulis dalam katakana, jangan pakai kanji atau huruf latin. Di <id> dan <vn> nama ditulis biasa.`}${pronounceRules(char, jp)}${userRule(user)}`
}

const remind = voice => voice.on
  ? `[Ingat: balas hanya dengan format <id>...</id><jp>...</jp><vn>...</vn>; tag ekspresi hanya di <vn>, suara ${voice.lang === 'jp' ? 'Jepang' : 'Indonesia'}]`
  : '[Ingat: balas hanya dengan format <id>...</id>]'

// ambil isi satu blok; berhenti di penutupnya, di awal blok lain, atau di akhir teks
const block = (raw, tag) =>
  (raw.match(new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|<(?:id|jp|vn)>|$)`, 'i'))?.[1] || '').trim()
const parse = raw => ({ id: block(raw, 'id'), jp: block(raw, 'jp'), vn: block(raw, 'vn') })

const historyBlock = (history, char, user) => history.length
  ? 'Riwayat obrolan sebelumnya (lanjutkan secara natural):\n' +
    history.map(([r, t]) => `${r === 'user' ? (user || 'User') : char.name}: ${t}`).join('\n') + '\n\n'
  : ''

async function ask(s, char, message, fresh, user, history, voice) {
  const head = fresh ? `${char.prompt}\n\n${formatRules(char, user, voice)}\n\n${historyBlock(history, char, user)}` : ''
  // nama ikut di setiap pesan, jadi kalau user ganti nama di tengah obrolan langsung terbaca
  let r = await chatgpt(`${head}Pesan dari user${user ? ` (namanya: ${user})` : ''}: ${message}\n\n${remind(voice)}`, s.auth, s.chatId)
  s.chatId = r.chatId
  let out = parse(r.response)
  const complete = o => o.id && (!voice.on || (o.jp && o.vn))
  if (!complete(out)) {
    const fmt = voice.on ? '<id>...</id><jp>...</jp><vn>...</vn>' : '<id>...</id>'
    r = await chatgpt(`Formatmu salah. Ulangi balasanmu barusan persis dengan format ${fmt}.`, s.auth, s.chatId)
    s.chatId = r.chatId
    out = parse(r.response)
  }
  if (!out.id) throw new Error('Respons kosong')
  return out
}

async function run(s, char, message, user, history, voice) {
  // format berubah (voice dinyalakan/dimatikan atau ganti bahasa) -> mulai sesi baru, riwayat tetap ikut dari client
  const fmtKey = voice.on ? `on:${voice.lang}` : 'off'
  const valid = s.auth && s.chatId && s.fmt === fmtKey && Date.now() - s.startedAt < TTL
  for (let fresh = !valid; ; fresh = true) {
    try {
      if (fresh) { s.auth = await getSession(); s.chatId = null; s.startedAt = Date.now(); s.fmt = fmtKey }
      return await ask(s, char, message, fresh, user, history, voice)
    } catch (e) {
      if (fresh) throw e // sesi lama gagal (expired/404) -> ulang sekali dengan sesi baru
    }
  }
}

export function reply(clientId, char, message, { user = '', history = [], voice = { on: false } } = {}) {
  const key = `${clientId}:${char.id}`
  const s = sessions.get(key) || { auth: null, chatId: null, startedAt: 0, fmt: '', q: Promise.resolve() }
  sessions.set(key, s)
  s.seen = Date.now()
  const job = s.q.then(() => run(s, char, message, user, history, voice)) // antrian per chat, cegah balapan parentMessageId
  s.q = job.catch(() => {})
  return job
}

setInterval(() => {
  for (const [k, s] of sessions) if (Date.now() - s.seen > 12 * 3600 * 1000) sessions.delete(k)
}, 3600 * 1000).unref()
